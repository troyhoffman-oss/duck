import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";

/*
 * The claude-login route: each model call is one fresh run of the official, signed-in `claude`, with its own
 * tools, settings, MCP and slash commands off and the caller's tools, system prompt and messages in its
 * request. `claude` sends that request to a loopback forwarder that lets exactly one request through to
 * Anthropic and hands the answer back as it arrives. This is Nous Research's claude-subscription-directsdk
 * pattern (MIT; see NOTICE-directsdk-MIT.txt beside this file).
 */

/** What keeps the Claude login whose home folder is `home` from answering, and what the admin does about it. */
export function loginProblems(home: string | undefined): string[] {
  if (!home) return ["model.login names no folder for the Claude login"];
  const signIn = `sign it in on this server with: mkdir -p -m 700 ${home} && HOME=${home} bunx @anthropic-ai/claude-code@${pkg.claude} auth login`;
  if (!existsSync(home)) return [`the Claude login folder ${home} does not exist; ${signIn}`];
  if (!existsSync(join(home, ".claude", ".credentials.json")))
    return [`the Claude login in ${home} is not signed in; ${signIn}`];
  return [];
}

const words = (text: string) => text.split(" ");

type Block = Record<string, unknown>;
/** One message, as a stream-json frame or as an entry of a conversation `claude` resumes. */
type Frame = { type: string; message: { id?: string; role: string; model?: string; content: Block[] } };

/** `claude` adds its own cache marks, and the API takes at most four, so the caller's go. */
function uncached(block: Block): Block {
  const { cache_control: _, ...rest } = block;
  return Array.isArray(rest.content) ? { ...rest, content: (rest.content as Block[]).map(uncached) } : rest;
}

const blocks = (content: unknown): Block[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : (content as Block[]).map(uncached);

/** The request fields `claude` merges into its own request; it sets the rest itself. */
const CARRIED = words("max_tokens thinking output_config stop_sequences context_management tool_choice");

/** One Messages API call on the Claude login whose home folder is `home`. */
export async function claudeLogin(home: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body));
  // `claude` passes an answer's thinking on only when the answer names the model it is asking.
  const model = String(body.model);
  const frames: Frame[] = [];
  for (const { role, content } of body.messages as { role: string; content: unknown }[]) {
    const last = frames.at(-1);
    if (role === "user" && last?.type === "user") last.message.content.push(...blocks(content));
    else
      frames.push({
        type: role,
        message: { role, ...(role === "assistant" && { model }), content: blocks(content) },
      });
  }
  const query = frames.pop() as Frame;
  // `claude` marks for the cache only the system prompt and the environment note it ends every request with,
  // and puts the account's address in the latest message, so that message differs on the next call. A mark on
  // the last answer, which the next call repeats as it is, lets the next call read the conversation from the
  // cache. The API refuses a mark on thinking or on empty text.
  const held = frames.pop();
  const repeated = held?.message.content.findLast(
    (b) => !String(b.type).includes("thinking") && b.text !== "",
  );
  if (repeated) repeated.cache_control = { type: "ephemeral", ttl: "1h" };

  // The history goes in as a conversation `claude` resumes, read in one go. A resumed conversation whose last
  // answer called tools is closed as interrupted, so that answer is written as an empty entry and sent on
  // standard input under the same id, where `claude` fills the entry in.
  const session = randomUUID();
  const conversation = join(home, ".claude", "projects", "-", `${session}.jsonl`);
  const input = [query];
  if (held) {
    const id = `msg_${session}`;
    frames.push({ type: "assistant", message: { id, role: "assistant", content: [] } });
    input.unshift({ ...held, message: { ...held.message, id } });
    let parentUuid: string | null = null;
    const timestamp = new Date().toISOString();
    const entries = frames.map(({ type, message }) => {
      const uuid = randomUUID();
      const entry = JSON.stringify({ type, uuid, parentUuid, sessionId: session, timestamp, message });
      parentUuid = uuid;
      return `${entry}\n`;
    });
    mkdirSync(join(conversation, ".."), { recursive: true });
    writeFileSync(conversation, entries.join(""), { mode: 0o600 });
  }

  // Tools and a system prompt can outgrow one argument, so they go in files.
  const dir = mkdtempSync(join(tmpdir(), "duck-claude-"));
  const system = blocks(body.system ?? "")
    .map((b) => b.text)
    .join("\n\n");
  writeFileSync(join(dir, "system.md"), system);
  const extra = Object.fromEntries(CARRIED.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  extra.tools = (body.tools as Block[] | undefined)?.map(uncached);
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(extra) } }),
  );

  const answered = Promise.withResolvers<Response>();
  let used = false;
  const forwarder = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      // One model call is one request upstream: a retry or a second turn from `claude` stops here.
      if (used) return new Response("this call has had its one request", { status: 400 });
      used = true;
      const headers = new Headers(request.headers);
      for (const name of ["host", "connection", "content-length"]) headers.delete(name);
      // An answer passed on as it arrives must not be compressed.
      headers.set("accept-encoding", "identity");
      const url = new URL(request.url);
      const sent = await fetch(`https://api.anthropic.com${url.pathname}${url.search}`, {
        method: "POST",
        headers,
        body: await request.arrayBuffer(),
        redirect: "error",
        signal: init.signal ?? null,
      }).catch((error: Error) => error);
      if (sent instanceof Error) {
        answered.reject(sent);
        return new Response(null, { status: 502 });
      }
      const [theirs, mine] = (sent.body as ReadableStream).tee();
      answered.resolve(new Response(mine, { status: sent.status, headers: sent.headers }));
      return new Response(theirs, { status: sent.status, headers: sent.headers });
    },
  });

  const effort = body.output_config?.effort;
  const child = Bun.spawn(
    [
      "claude",
      ...words(`-p --model ${model} --verbose --input-format stream-json --output-format stream-json`),
      ...words("--strict-mcp-config --disable-slash-commands --no-session-persistence"),
      ...["--tools", "", "--setting-sources", ""],
      ...["--system-prompt-file", join(dir, "system.md"), "--settings", join(dir, "settings.json")],
      // A tool call ends the run here, with error_max_turns: that is the call's end, not a failure.
      ...["--max-turns", "1"],
      ...(held ? ["--resume", session] : []),
      // `claude` tells the model its effort as well as sending it, so the two must agree.
      ...(typeof effort === "string" ? ["--effort", effort] : []),
    ],
    {
      // `claude` resumes a conversation from the folder named for its working folder: projects/- for "/".
      cwd: "/",
      env: {
        HOME: home,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${forwarder.port}`,
        ANTHROPIC_BETAS: (init.headers as Record<string, string>)["anthropic-beta"] ?? "",
        // Also stops the auto-updater, which would install a second `claude` in the login's folder.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CODE_MAX_RETRIES: "0",
        DISABLE_AUTO_COMPACT: "1",
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        TMPDIR: dir,
      },
      stdin: new Blob(input.map((f) => `${JSON.stringify(f)}\n`)),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // Closing `claude`'s connection first keeps the answer it is reading from failing when the abort cuts it,
  // which Bun would print as uncaught.
  init.signal?.addEventListener("abort", () => {
    forwarder.stop(true);
    child.kill();
  });
  void Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).then(
    ([out, err, code]) => {
      forwarder.stop(true);
      rmSync(dir, { recursive: true, force: true });
      rmSync(conversation, { force: true });
      const last = `${out}${err}`.trim().split("\n").at(-1);
      answered.reject(new Error(`claude exited ${code} before sending a request: ${last}`));
    },
  );
  return answered.promise;
}

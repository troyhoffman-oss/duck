import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createGrpcClient, type IMessageError, type MessagePart } from "@photon-ai/advanced-imessage/grpc";
import { heard, told } from "./archive";
import { readIn } from "./gate";
import { aboutSession, add, broken, type Event, lastEvent, mark as state, waiting } from "./inbox";
import type { Coworker } from "./run";
import { type Door, doorsOf, FILES, factsOf, fileOf, HOME, ownerOf, secret } from "./setup";
import { buzzKey } from "./setup/coworkers";
import { inCall, voiceIn } from "./voice";

/** A file as it crosses a door: its name, media type and bytes in base64. */
type DoorFile = { name: string; type: string; data: string };
/**
 * Where in Buzz a message was written: the channel, the event an answer threads under, if any, the root of
 * its thread, if it is in one, and whether the channel is a DM.
 */
type Place = { channel: string; reply?: string; root?: string; dm?: boolean };

const PATH = new RegExp(`(?:${HOME}|${FILES})/[^\\s"'\`<>()]+`, "g");

/**
 * What was written at a door, under the door's own id for it. At a buzz door, `writer` is who wrote it: their
 * key as the relay holds the event, their name as buzz-acp gives it, and the channel they wrote in.
 */
type Written = {
  id: string;
  text: string;
  files?: DoorFile[];
  place?: Place;
  writer?: { key: string; name: string; where: string };
  /** When it was written, by the door's own clock, where the door gives it. */
  at?: string;
};

/**
 * Takes what was written at an http or buzz `door`, sent with the door's key. At a buzz door only what the
 * owner wrote is the person's message; anything else is an event that says who wrote it and where. In a
 * thread the coworker wrote in, or a DM, it goes on in the session that last wrote or was answered there;
 * elsewhere it is outside words on the work lane, or at a door that answers others, the start of an others
 * run. Either keeps the place it was written and is about its thread. At a buzz door the answer to the
 * person's message ends when the runs it woke or steered have, and what they said has gone out.
 */
export async function take(c: Coworker, door: string, request: Request) {
  const set = doorsOf(c.setup, c.name)[door];
  if (!set || request.method !== "POST") return new Response("not found", { status: 404 });
  if (request.headers.get("authorization") !== `Bearer ${keyOf(c, set)}`)
    return new Response("wrong key", { status: 401 });
  const body = (await request.json()) as Written;
  let ended: Promise<unknown> | null = null;
  if (set.kind !== "buzz" || body.writer?.key === ownerOf(c.setup, c.name)) ended = taken(c, door, body);
  else {
    const { name: from, key, where } = body.writer ?? {};
    const { channel, root, dm } = body.place ?? {};
    const at = root ? `${channel}/${root}` : dm ? `${channel}/` : null;
    const wrote = at === null ? undefined : aboutSession(c.db, `${door}:reply`, at, !root);
    const [place, thread] =
      set.answers || wrote ? [body.place, `${channel}/${root ?? body.id}`] : [undefined, null];
    const payload = JSON.stringify({ from, key, where, text: body.text, ...place });
    add(c.db, `${door}:${wrote ? "reply" : "others"}`, body.id, payload, null, wrote ?? null, thread);
    c.wake();
  }
  if (set.kind !== "buzz" || !ended) return new Response(null, { status: 202 });
  // bun sends a response's head with its first bytes.
  const held = (async function* () {
    yield "taken\n";
    await ended;
  })();
  return new Response(held, { status: 202 });
}

/** Writes `bytes` as a new file at `path`, never through a link there; false when the name is taken, by a link or a file. */
function madeAt(path: string, bytes: Buffer) {
  try {
    writeFileSync(path, bytes, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Saves `bytes` in `folder` as `name`, numbered before its extension when the name is taken. Returns the name it has. */
export function saved(folder: string, name: string, bytes: Buffer) {
  const dot = name.lastIndexOf(".") > 0 ? name.lastIndexOf(".") : name.length;
  let at = name;
  for (let n = 2; !madeAt(join(folder, at), bytes); n++) at = `${name.slice(0, dot)}-${n}${name.slice(dot)}`;
  return at;
}

/**
 * Writes what the person wrote at `door` as an inbox event, with their files where the coworker reads them
 * and cannot change them, and wakes the coworker. A buzz door's message keeps its place as the payload. At a
 * door but email or voice, where no ask goes, it is held as `reading` until duck has read what it answers of
 * the questions it asked them (SPEC part 9). It returns when the runs the message wakes or steers have ended
 * and what they said has gone out, or null for a message already taken.
 */
function taken(c: Coworker, door: string, body: Written) {
  const reads = askDoors(c).includes(door);
  const event = c.db.transaction(() => {
    const event = add(c.db, door, body.id, body.place ? JSON.stringify(body.place) : null);
    if (event === null) return null;
    if (reads) state(c.db, [event], "reading");
    const files = (body.files ?? []).map((f) => {
      const folder = join(c.files, String(event));
      mkdirSync(folder, { recursive: true });
      return `${FILES}/${event}/${saved(folder, basename(f.name), Buffer.from(f.data, "base64"))}`;
    });
    heard(c.db, door, event, body.text, files, body.at);
    return event;
  })();
  if (event === null) return null;
  return (reads ? readIn(c, event) : Promise.resolve()).then(() => c.wake()).then(() => c.sending);
}

/** The doors of `c` an ask may go to: all its person's doors but email and voice, since neither answers an ask. */
export const askDoors = (c: Coworker) =>
  c.doors.filter((d) => !["email", "voice"].includes(doorsOf(c.setup, c.name)[d]?.kind as string));

/**
 * Where `c`'s next message goes: the call the person is in with the coworker, or else the door among their
 * own but voice where they last wrote, or before they ever have, the first; for an `ask`, among `askDoors`
 * where it has any. With that door's setup and their last message there.
 */
export function doorTo(c: Coworker, ask = false) {
  const call = ask ? undefined : inCall(c);
  if (call?.say) return { door: call.door, set: doorsOf(c.setup, c.name)[call.door] as Door, last: null };
  const spoken = (d: string) => doorsOf(c.setup, c.name)[d]?.kind === "voice";
  const doors = ask && askDoors(c).length > 0 ? askDoors(c) : c.doors.filter((d) => !spoken(d));
  const last = lastEvent(c.db, doors);
  const door = last?.source ?? (doors[0] as string);
  return { door, set: doorsOf(c.setup, c.name)[door] as Door, last };
}

/**
 * Sends `text` from the main conversation, an `ask` or not, to the door `doorTo` names, with each file of the
 * coworker's it names, which the person sees by its name: at a buzz door, to the place of their last message
 * there; in a call, to the speech model to say, which the archive keeps as it is said. It returns the door,
 * the archive's id of the message where it is kept now, and `delivered`: when the try the door took ended, or
 * null when it took none. A delivery the door does not take after three tries is logged as not delivered,
 * and the door is broken.
 */
export function deliver(c: Coworker, said: string, since: number, ask = false) {
  const { door, set, last } = doorTo(c, ask);
  const named = [...new Set(said.match(PATH) ?? [])].map((p) => p.replace(/[.,;:!?]+$/, ""));
  const files = named.filter((p) => fileOf(c.setup, c.name, p));
  const text = files.reduce((t, p) => t.replaceAll(p, basename(p)), said);
  console.log(JSON.stringify({ reply: c.name, door, ms: Math.round(performance.now() - since) }));
  if (set.kind === "voice") {
    inCall(c)?.say?.(text);
    return { door, id: undefined, delivered: Promise.resolve(Date.now()) };
  }
  const id = told(c.db, door, c.conversation() ?? null, text, files);
  const local = files.map((p) => fileOf(c.setup, c.name, p) as string);
  const body = JSON.stringify({
    id: `${c.name}-${id}`,
    text,
    files: local.map((l, i) => ({
      name: basename(files[i] as string),
      type: Bun.file(l).type,
      data: readFileSync(l).toString("base64"),
    })),
  });
  const http = async () => {
    const sent = await fetch(set.address, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret(c.setup, set.key)}` },
      body,
    });
    if (!sent.ok) throw new Error(String(sent.status));
  };
  const send =
    set.kind === "buzz"
      ? () => post(c, set, last?.payload ?? null, text, local)
      : set.kind === "text"
        ? () => textOut(c, set, `${c.name}-${id}`, text, local)
        : set.kind === "email"
          ? () => mailOut(c, set, last, `${c.setup.firm}-${c.name}-${id}`, text, local)
          : http;
  const delivered = c.sending.then(async () => {
    const failed = await tried(`delivery ${c.name}-${id} at ${door}`, send);
    if (!failed) return Date.now();
    console.error(`message ${c.name}-${id} was not delivered at ${door}`);
    // Told once a door until the person writes again, so a telling that fails there too is not told again.
    broken(c, `${door}:${last?.id ?? 0}`, { door, undelivered: text, because: failed.message });
    return null;
  });
  c.sending = delivered.then(() => {});
  return { door, id, delivered };
}

/**
 * Keeps `part` of door `door` going until the coworker stops. Each time it stops it is logged with why and
 * started again, after 1 s, or while it keeps stopping within a minute of starting, after a wait that doubles
 * from 2 s to 5 min. A part started again that stops within that minute has not come back, and the door is
 * broken: told once for each time it is down.
 */
async function keep(c: Coworker, door: string, what: string, part: () => Promise<unknown>) {
  for (
    let [wait, down] = [1000, 0];
    !c.signal.aborted;
    await sleep(wait, undefined, { signal: c.signal }).catch(() => {})
  ) {
    const began = Date.now();
    const because = await part().then(
      () => "it ended",
      (error: Error) => error.message,
    );
    if (c.signal.aborted) return;
    const brief = Date.now() - began < 60_000;
    wait = brief ? Math.min(wait * 2, 300_000) : 1000;
    console.error(`${what} stopped: ${because}; it starts again in ${wait / 1000} s`);
    if (!brief || !down) down = Date.now();
    else broken(c, `${door} down since ${new Date(down).toISOString()}`, { door, stopped: what, because });
  }
}

/** Calls `send` up to three times, 5 s apart, logging each failure of `what`. Returns the last failure, if all failed. */
async function tried(what: string, send: () => Promise<void>) {
  for (let tries = 1; ; tries++) {
    const failed = await send().catch((error: Error) => error);
    if (!failed) return;
    console.error(`${what} failed: ${failed.message}`);
    if (tries === 3) return failed;
    await Bun.sleep(5000);
  }
}

/**
 * Posts `text`, what an others run ended on, as a reply where `e`, someone else's event at a buzz door, was
 * written. It is tried three times, 5 s apart, apart from what goes to the person, so it never holds that up,
 * and then logged as not posted. An event Buzz gave no channel for is logged and not answered.
 */
export async function answerOthers(c: Coworker, e: Event, text: string) {
  const door = e.source.replace(/:others$/, "");
  const set = doorsOf(c.setup, c.name)[door] as Door;
  const what = `the answer to ${e.ref} at ${c.name}.${door}`;
  if (!JSON.parse(e.payload ?? "{}").channel) return console.error(`${what} has no place in Buzz to go`);
  console.log(JSON.stringify({ answer: c.name, door, about: e.about }));
  if (await tried(what, () => post(c, set, e.payload, text, []))) console.error(`${what} was not posted`);
}

/** The key door `set` of `c` is sent with: at a buzz door, the coworker's own Buzz key, which duck made. */
const keyOf = (c: Coworker, set: Door) => secret(c.setup, set.key, set.kind === "buzz" ? c.name : undefined);

/** Who buzz-acp and Buzz's CLI act as at buzz door `set` of `c`, and where: its key, relay and owner's tag. */
const identity = (c: Coworker, set: Door) => ({
  BUZZ_RELAY_URL: set.address,
  BUZZ_PRIVATE_KEY: keyOf(c, set),
  BUZZ_AUTH_TAG: factsOf(c.setup, c.name).owner ?? "",
});

/**
 * Runs Buzz's CLI with `args` and `input` as coworker `c`, at its buzz door, in the folder `cwd`, which is
 * also its home, with nothing in its environment but its path, who it acts as and where, and the output Buzz
 * gives the agents it hosts, and returns what it printed (SPEC part 9).
 */
export function act(c: Coworker, args: string[], input: string | undefined, cwd: string) {
  const env = { PATH: process.env.PATH, HOME: cwd, ...identity(c, doorsOf(c.setup, c.name).buzz as Door) };
  return buzz({ ...env, BUZZ_OUTPUT_FORMAT: "agent" }, args, input, cwd);
}

/** Runs Buzz's CLI in `env`, in `cwd` if given, and returns what it printed, or throws with its error. */
async function buzz(env: Record<string, string | undefined>, args: string[], input?: string, cwd?: string) {
  const child = Bun.spawn(["buzz", ...args], {
    env,
    cwd,
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`buzz ${args.slice(0, 2).join(" ")} exited ${code}: ${err.trim()}`);
  return Buffer.from(out);
}

/** Posts `text`, with `files`, at the place in `payload`, or with none, in the DM with the coworker's owner. */
async function post(c: Coworker, set: Door, payload: string | null, text: string, files: string[]) {
  const env = { ...process.env, ...identity(c, set) };
  const owner = JSON.parse(env.BUZZ_AUTH_TAG)[1];
  const place: Place = payload
    ? JSON.parse(payload)
    : { channel: JSON.parse((await buzz(env, ["dms", "open", "--pubkey", owner])).toString()).dm_id };
  const reply = place.reply ? ["--reply-to", place.reply] : [];
  // Buzz refuses a message whose "@word" names no member, unless a mention is given; it then leaves the word as
  // text. Its own key is always a member, and the tag it adds notifies no one and starts no run.
  const mention = ["--mention", buzzKey(c.setup, c.name)];
  const attached = files.flatMap((f) => ["--file", f]);
  await buzz(
    env,
    ["messages", "send", "--channel", place.channel, ...reply, ...mention, ...attached, "--content", "-"],
    text,
  );
}

/**
 * Starts buzz-acp at each buzz door of `c`. It hands each Buzz message for the coworker to `duck buzz` as an
 * ACP prompt: in a DM, from the owner or an agent the owner also owns, and where it is mentioned, from them or
 * at a door that answers anyone from anyone, as buzz-acp's gate admits in its owner-only and anyone modes.
 * When it needs a mention stays at Buzz's default. At each text door it opens Photon's stream, at each email
 * door the mail service's, and at a voice door it joins the person's calls with the coworker. buzz-acp stops
 * when it cannot reach its relay after a few tries, and a stream can end, so each is kept going until the
 * coworker stops, which ends buzz-acp and the stream. It settles when every door has stopped.
 */
export function listen(c: Coworker) {
  const port = c.setup.listen.split(":")[1];
  const doors = Object.entries(doorsOf(c.setup, c.name)).map(([door, set]) => {
    if (set.kind === "text") return textIn(c, door, set);
    if (set.kind === "email") return mailIn(c, door, set);
    if (set.kind === "voice") return voiceIn(c, door, set, (id, text) => taken(c, door, { id, text }));
    if (set.kind !== "buzz") return undefined;
    return keep(c, door, `buzz-acp at ${c.name}.${door}`, async () => {
      const acp = Bun.spawn(["buzz-acp"], {
        env: {
          ...process.env,
          ...identity(c, set),
          BUZZ_ACP_AGENT_COMMAND: "bun",
          BUZZ_ACP_AGENT_ARGS: `${Bun.main},buzz,http://127.0.0.1:${port}/doors/${c.name}/${door}`,
          // The coworker's own conversation is its context, so buzz-acp sends none of the channel's.
          BUZZ_ACP_CONTEXT_MESSAGE_LIMIT: "0",
          BUZZ_ACP_RESPOND_TO: set.answers ?? "owner-only",
          // A turn stays open while the person's runs go on, and a busy agent gets only its own place's
          // events, so the events of other places go to the pool's other agents meanwhile.
          BUZZ_ACP_AGENTS: "4",
        },
        stdout: "inherit",
        stderr: "inherit",
        signal: c.signal,
      });
      throw new Error(`it exited ${await acp.exited}`);
    });
  });
  return Promise.all(doors);
}

/**
 * buzz-acp's ACP agent at a buzz door (`duck buzz <door>`). Each prompt's Buzz events go to `door`, each
 * with who wrote it, its files and the place buzz-acp names, and the prompt ends when duck's answer to each
 * does, so buzz-acp's typing and reaction last as long. It reads on meanwhile: buzz-acp steers with a cancel
 * and a prompt that holds the new event, and the cancel ends the open prompt and not duck's runs. A failure,
 * duck's ending among them, ends this process, and with it buzz-acp's turn. buzz-acp's own system prompt is
 * not used: the coworker answers from its main conversation, and duck posts the answer.
 */
export async function face(door: string) {
  const answer = (id: unknown, reply: object) =>
    console.log(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
  /** The prompt not yet answered, if any. */
  let open: unknown;
  const end = (id: unknown, stopReason: string) => {
    if (id === undefined || id !== open) return;
    open = undefined;
    answer(id, { result: { stopReason } });
  };
  const failed = (error: Error) => {
    console.error(`duck's buzz door stopped: ${error.message}`);
    process.exit(1);
  };
  for await (const line of console) {
    const { id, method, params } = JSON.parse(line);
    if (method === "initialize")
      answer(id, {
        result: { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] },
      });
    else if (method === "session/new") answer(id, { result: { sessionId: crypto.randomUUID() } });
    else if (method === "session/prompt") {
      open = id;
      void hand(door, params.prompt.map((b: { text?: string }) => b.text ?? "").join("\n"))
        .then((ends) => Promise.all(ends))
        .then(() => end(id, "end_turn"), failed);
    } else if (method === "session/cancel") end(open, "cancelled");
    else if (id !== undefined)
      answer(id, { error: { code: -32601, message: `duck's buzz door has no ${method}` } });
  }
}

/**
 * Posts each Buzz event in buzz-acp's prompt `text` to `door`, with who wrote it and where, and returns duck's
 * answer to each. buzz-acp writes an event's content as it was written, so content can hold what reads as
 * another event: each event's writer, text and files are read from the relay by its id, and one whose writer
 * the relay does not bear out is dropped.
 */
async function hand(door: string, text: string) {
  const context = text.split("</context>")[0] ?? "";
  const ends: Promise<string>[] = [];
  const channel = /\(#([0-9a-f-]{36})\)/.exec(context)?.[1];
  const place = channel
    ? {
        channel,
        reply: /--reply-to ([0-9a-f]{64})/.exec(context)?.[1],
        root: /^Thread root: ([0-9a-f]{64})$/m.exec(context)?.[1],
        dm: /^Scope: dm$/m.test(context),
      }
    : undefined;
  const where = /^Channel: (.*)$/m.exec(context)?.[1] ?? "";
  for (const block of text.split(/^Event ID: (?=[0-9a-f]{64}$)/m).slice(1)) {
    const [id, name] = [block.slice(0, 64), /^From: (.*)$/m.exec(block)?.[1] ?? ""];
    const [event] = JSON.parse((await buzz(process.env, ["social", "event", "--event", id])).toString()) as {
      pubkey: string;
      content: string;
      tags: string[][];
      created_at?: number;
    }[];
    if (!event || !name.endsWith(`hex: ${event.pubkey})`)) {
      console.error(
        `duck's buzz door dropped Buzz event ${id}: the relay does not hold it as buzz-acp gave it`,
      );
      continue;
    }
    // A file is an imeta tag of "<field> <value>" entries (NIP-92).
    const files = event.tags
      .filter((t) => t[0] === "imeta")
      .map((t) =>
        Object.fromEntries(t.slice(1).map((e) => [e.slice(0, e.indexOf(" ")), e.slice(e.indexOf(" ") + 1)])),
      )
      .map((f) => f as { url: string; m: string; filename?: string });
    const body = {
      id,
      text: event.content,
      place,
      writer: { key: event.pubkey, name, where },
      ...(event.created_at && { at: new Date(event.created_at * 1000).toISOString() }),
      files: await Promise.all(
        files.map(async (f) => ({
          name: f.filename ?? basename(f.url),
          type: f.m,
          data: (await buzz(process.env, ["media", "get", f.url, "-o", "-"])).toString("base64"),
        })),
      ),
    };
    const sent = await fetch(door, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.BUZZ_PRIVATE_KEY}`,
      },
      body: JSON.stringify(body),
      // Its answer comes when the runs it woke end, which may be long after Bun's default 5-minute idle limit.
      timeout: false,
    });
    if (sent.status !== 202) throw new Error(`duck took Buzz event ${body.id} with ${sent.status}`);
    ends.push(sent.text());
  }
  return ends;
}

/**
 * Photon's client for the line at text door `set`. Each call takes a token Spectrum mints for the line's
 * project, which mints the same one again while it lasts (measured).
 */
function line(c: Coworker, set: Door) {
  const basic = btoa(`${set.address.split("/").pop()}:${secret(c.setup, set.key)}`);
  const token = async () => {
    const minted = await fetch(`${set.address}/imessage/tokens`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}` },
    });
    const { data } = (await minted.json().catch(() => ({}))) as { data?: { type: string; token: string } };
    if (data?.type !== "shared") throw new Error(`Spectrum gave no shared line's token (${minted.status})`);
    return data.token;
  };
  const { hostname, port, protocol } = new URL(set.line as string);
  return createGrpcClient({ address: `${hostname}:${port || 443}`, tls: protocol === "https:", token });
}

/** The direct chat of text door `set`'s person. */
const chatOf = (c: Coworker, set: Door) => `any;-;${secret(c.setup, set.auth as string)}`;

/** How often typing is sent again while held. Photon gives typing no lifetime; its own agent, poki, sends it every 20 s. */
const TYPING = 20_000;
/** Each text door's typing, sent again after a text goes out there, since a sent text can clear it. */
const typists = new Map<Door, () => Promise<void>>();
let stopping = false;

/** Ends typing at every text door, waiting for Photon at most 2 s, since duck is stopping. */
export async function quiet() {
  stopping = true;
  await Promise.race([Promise.all([...typists.values()].map((typing) => typing())), Bun.sleep(2000)]);
}

/**
 * Hands each text its person sends text door `set`'s line in to `door`, with its files. A text from anyone
 * else, or in a group, is dropped, and each such sender logged once. A text taken is marked read, and typing
 * shows in the chat until the runs it woke or steered have ended, as it does for a run a restart cut; both
 * are best effort, each failure logged. The stream is kept going: it stops when it ends, which the client's
 * keepalive makes it do on a dead connection, and each new one has a client of its own.
 */
async function textIn(c: Coworker, door: string, set: Door) {
  const person = secret(c.setup, set.auth as string);
  const chat = chatOf(c, set);
  let im = line(c, set);
  const strangers = new Set<string>();
  let [runs, every, calls] = [0, undefined as Timer | undefined, Promise.resolve()];
  // One call at a time, so typing ends as the last call left it.
  const best = (what: string, call: () => Promise<void>) => {
    const failed = (error: Error) =>
      console.error(`the text door ${c.name}.${door} could not ${what}: ${error.message}`);
    calls = calls.then(call).catch(failed);
    return calls;
  };
  const typing = () =>
    best("set typing", () => im.chats.setTyping(chat, runs > 0 && !stopping && !c.signal.aborted));
  /** Shows typing until `ended`. */
  const hold = (ended: Promise<void>) => {
    runs += 1;
    typing();
    every ??= setInterval(typing, TYPING);
    typists.set(set, typing);
    void ended.then(() => {
      if (--runs > 0 || c.signal.aborted) return;
      clearInterval(every);
      every = undefined;
      typists.delete(set);
      typing();
    });
  };
  let stream: { close(): Promise<void> } | undefined;
  c.signal.addEventListener("abort", () => {
    clearInterval(every);
    typists.delete(set);
    void stream?.close();
  });
  // A run a restart cut goes on with typing, and typing a crash left on ends.
  if (waiting(c.db, [door], undefined).length > 0) hold(c.wake().then(() => c.sending));
  else typing();
  await keep(c, door, `the text door ${c.name}.${door}'s stream`, async () => {
    try {
      const events = im.messages.subscribeEvents();
      stream = events;
      for await (const e of events) {
        if (e.type !== "message.received" || e.message.isFromMe) continue;
        const from = e.message.sender?.address ?? e.actor?.address ?? "";
        if (from !== person || !e.chatGuid.includes(";-;")) {
          if (!strangers.has(from))
            console.error(`the text door ${c.name}.${door} dropped a text not its person's`);
          strangers.add(from);
          continue;
        }
        const files = e.message.content.attachments
          .filter((a) => !a.isHidden)
          .map(async (a) => {
            const chunks: Uint8Array[] = [];
            for await (const f of im.attachments.downloadStream(a.guid))
              if (f.type === "primaryChunk") chunks.push(f.data);
            return { name: a.fileName, type: a.mimeType, data: Buffer.concat(chunks).toString("base64") };
          });
        // Apple marks where each attachment sits in the text with an object replacement character.
        const text = (e.message.content.text ?? "").replaceAll(String.fromCodePoint(0xfffc), "").trim();
        const at = e.message.dateCreated.toISOString();
        const ended = taken(c, door, { id: e.message.guid, text, files: await Promise.all(files), at });
        if (!ended || c.signal.aborted) continue;
        best("mark a text read", () => im.chats.markRead(chat));
        hold(ended);
      }
      throw new Error("Photon ended its stream");
    } finally {
      im.close();
      im = line(c, set);
    }
  });
  // The coworker stopped: its typing ends, waiting for Photon at most 2 s, as when duck stops.
  await Promise.race([typing(), Bun.sleep(2000)]);
  im.close();
}

const STYLES = ["bold", "italic", "strikethrough"] as const;
const [CELL, ROW] = ["\u001f", "\u001e"];
/** `c` between the private-use characters that stand for where style `s` starts and ends. */
const mark = (s: number) => (c: string) =>
  `${String.fromCharCode(0xe000 + 2 * s)}${c}${String.fromCharCode(0xe001 + 2 * s)}`;
const [bold, block] = [mark(0), (c: string) => `${c.trimEnd()}\n\n`];

/**
 * The coworker's markdown as iMessage's own styled text: its words and the ranges iMessage shows bold, italic
 * or struck through. A heading is bold, a link reads "label (url)", a list item starts with a bullet or its
 * number and code is left as written. iMessage has no tables, so each row of one is its first cell in bold,
 * then "header: value" for each other cell that has a value.
 */
function styled(markdown: string) {
  const marked = Bun.markdown
    .render(markdown, {
      heading: (c) => block(bold(c)),
      paragraph: block,
      code: block,
      hr: () => block("———"),
      list: (c, { depth }) => (depth > 0 ? `\n${c.trimEnd()}` : block(c)),
      listItem: (c, { index, depth, ordered, start }) =>
        `${"  ".repeat(depth)}${ordered ? `${(start ?? 1) + index}.` : "•"} ${c.trim()}\n`,
      strong: bold,
      emphasis: mark(1),
      strikethrough: mark(2),
      link: (c, { href }) => (c === href ? c : `${c} (${href})`),
      th: (c) => c + CELL,
      td: (c) => c + CELL,
      tr: (c) => c + ROW,
      table: (c) => {
        const [head = [], ...rows] = c
          .split(ROW)
          .slice(0, -1)
          .map((r) => r.split(CELL));
        const stack = ([first, ...cells]: string[]) =>
          [first && bold(first), ...cells.map((v, i) => (v && head[i + 1] ? `${head[i + 1]}: ${v}` : v))]
            .filter(Boolean)
            .join("\n");
        return block(rows.map(stack).join("\n\n"));
      },
    })
    .trim();
  let text = "";
  const open = STYLES.map((type) => ({ type, depth: 0, start: 0 }));
  const formatting: { type: (typeof STYLES)[number]; start: number; length: number }[] = [];
  for (const ch of marked) {
    const k = ch.charCodeAt(0) - 0xe000;
    const style = open[k >> 1];
    if (!style) text += ch;
    else if (k % 2 === 0) style.start = style.depth++ === 0 ? text.length : style.start;
    else if (--style.depth === 0 && text.length > style.start)
      formatting.push({ type: style.type, start: style.start, length: text.length - style.start });
  }
  return { text, formatting };
}

/**
 * Texts `words`, styled, with `files`, from text door `set`'s line to its person, under `id`, and shows typing
 * again if a run there still goes on. Photon refuses an id it has sent as a duplicate, so a send tried again
 * after a lost answer goes once.
 */
async function textOut(c: Coworker, set: Door, id: string, words: string, files: string[]) {
  const im = line(c, set);
  const parts: MessagePart[] = [styled(words)];
  for (const f of files) {
    const { attachment } = await im.attachments.upload({ fileName: basename(f), data: readFileSync(f) });
    parts.push({ attachmentGuid: attachment.guid, attachmentName: basename(f) });
  }
  await im.messages
    .sendMultipart(chatOf(c, set), parts, { clientMessageId: id })
    .catch((error: IMessageError) => {
      if (error.code !== "duplicateMessage") throw error;
    })
    .finally(() => im.close());
  void typists.get(set)?.();
}

/** A mail as the mail service gives it, in the fields the email door reads. */
type Mail = {
  message_id: string;
  thread_id: string;
  from: string;
  subject?: string;
  text?: string;
  extracted_text?: string;
  attachments?: {
    attachment_id: string;
    filename?: string;
    content_type?: string;
    /** `inline` with a `content_id` for a picture the mail's own body shows, a signature's or a pasted one. */
    content_disposition?: string;
    content_id?: string;
  }[];
  /** The service's SPF and DMARC verdicts, each kept only where it speaks for the sender's From domain. */
  authentication_results?: { spf?: string; dmarc?: string };
};

/**
 * Calls email door `set`'s mail service at `path` under the coworker's mailbox, with the mailbox's key: a GET,
 * or with `body` a POST, which the service sends once under `once` however often it is tried.
 */
async function mail<T>(c: Coworker, set: Door, path: string, body?: object, once?: string): Promise<T> {
  const at = `${set.address}/v0/inboxes/${encodeURIComponent(set.mailbox as string)}${path}`;
  const answer = await fetch(at, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${secret(c.setup, set.key)}`,
      "content-type": "application/json",
      ...(once && { "idempotency-key": once }),
    },
    body: body && JSON.stringify(body),
  });
  if (!answer.ok) throw new Error(`the mail service answered ${path.split("?")[0]} with ${answer.status}`);
  return answer.json() as Promise<T>;
}

/** How often the email door pings its stream; one that died without closing is noticed within twice this. */
const PING = 30_000;

/**
 * Hands each mail its person sends email door `set`'s mailbox to `door`, with its files: one from their
 * address alone that passed the mail service's sender checks, an SPF or a DMARC pass for their own domain,
 * since a From line can be forged. Any other mail there is outside words: an event about its thread on the
 * work lane, with whom it says it is from, its words, its files' names and its checks; its files stay at the
 * service. A picture the mail's body shows is handed over as a file like any other, and named as one shown in
 * its body, so the coworker tells a signature's logo from a pasted screenshot by what the mail says. The
 * stream is kept going, and each time it opens every mail received since a day before the door
 * last took one is listed, page by page, so mail that came while it was down is taken; the inbox takes each
 * once, by its id. A stream that answers no ping is closed, which opens it again.
 */
async function mailIn(c: Coworker, door: string, set: Door) {
  const person = secret(c.setup, set.auth as string).toLowerCase();
  const what = `the email door ${c.name}.${door}`;
  let socket: WebSocket | undefined;
  let queue = Promise.resolve();
  c.signal.addEventListener("abort", () => socket?.close());
  const took = async (id: string) => {
    const m = await mail<Mail>(c, set, `/messages/${encodeURIComponent(id)}`);
    const from = (/<([^>]*)>/.exec(m.from)?.[1] ?? m.from).trim().toLowerCase();
    const { spf, dmarc } = m.authentication_results ?? {};
    // The service's extracted_text leaves out the lines a mail quotes, which are not the sender's words.
    const words = [m.subject, (m.extracted_text ?? m.text ?? "").trim()].filter(Boolean).join("\n\n");
    const attached = m.attachments ?? [];
    const name = (a: (typeof attached)[number]) => a.filename ?? a.attachment_id;
    // The service marks a picture the mail's body shows inline with a content id: a signature's logo or a
    // screenshot pasted into the words. Which it is, the coworker reads from the mail, so code only names them.
    const shown = attached.filter((a) => a.content_disposition === "inline" && a.content_id).map(name);
    if (from !== person || m.from.split("@").length !== 2 || ![spf, dmarc].includes("pass")) {
      const files = attached.map(name);
      const payload = { from: m.from, text: words, files, shown_in_body: shown, checks: { spf, dmarc } };
      if (add(c.db, `${door}:others`, id, JSON.stringify(payload), null, null, m.thread_id)) void c.wake();
      return;
    }
    const text = shown.length > 0 ? `${words}\n\nShown in the mail's body: ${shown.join(", ")}.` : words;
    const files = attached.map(async (a) => {
      const at = `/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(a.attachment_id)}`;
      const got = await fetch((await mail<{ download_url: string }>(c, set, at)).download_url);
      if (!got.ok) throw new Error(`its file ${a.filename} could not be downloaded (${got.status})`);
      const data = Buffer.from(await got.arrayBuffer()).toString("base64");
      return { name: name(a), type: a.content_type ?? "", data };
    });
    taken(c, door, { id, text, files: await Promise.all(files) });
  };
  // One mail at a time, in the order the service gave them.
  const next = (id: string) => {
    queue = queue
      .then(() => took(id))
      .catch((e: Error) => console.error(`${what} took no mail ${id}: ${e.message}`));
  };
  // Every mail received after `after`, oldest first, a page at a time until the service gives no next page.
  const listAfter = async (after: string) => {
    for (let page = ""; ; ) {
      const listed = await mail<{ messages: { message_id: string }[]; next_page_token?: string }>(
        c,
        set,
        `/messages?ascending=true&limit=100&after=${encodeURIComponent(after)}${page && `&page_token=${encodeURIComponent(page)}`}`,
      );
      for (const m of listed.messages) next(m.message_id);
      if (!listed.next_page_token) return;
      page = listed.next_page_token;
    }
  };
  await keep(c, door, `${what}'s stream`, async () => {
    const ended = Promise.withResolvers<never>();
    // AgentMail's stream is at its API's host with ws for api: wss://ws.agentmail.to for https://api.agentmail.to.
    const stream = `${set.address.replace(/^http/, "ws").replace("//api.", "//ws.")}/v0`;
    const headers = { authorization: `Bearer ${secret(c.setup, set.key)}` };
    const ws = new WebSocket(stream, { headers });
    socket = ws;
    let beat: ReturnType<typeof setInterval> | undefined;
    let answered = true;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", inbox_ids: [set.mailbox] }));
      // The service answers a WebSocket ping with a pong. A stream that answered none since the last ping has
      // died without closing; it is closed, so it opens again and lists what came meanwhile.
      beat = setInterval(() => {
        if (!answered) {
          ended.reject(new Error(`its stream answered no ping in ${PING / 1000} s`));
          return ws.terminate();
        }
        answered = false;
        ws.ping();
      }, PING);
    };
    ws.addEventListener("pong", () => {
      answered = true;
    });
    ws.onmessage = ({ data }) => {
      const e = JSON.parse(String(data));
      if (e.type === "subscribed") {
        const last = lastEvent(c.db, [door, `${door}:others`])?.received_at;
        const after = new Date(last ? Date.parse(last) - 86_400_000 : Date.now()).toISOString();
        listAfter(after).catch((error: Error) =>
          console.error(`${what} could not list its mail since ${after}: ${error.message}`),
        );
      } else if (e.type === "event" && String(e.event_type).startsWith("message.received"))
        next(e.message.message_id);
      else if (e.type === "error") {
        ended.reject(new Error(`the mail service refused it: ${e.name}: ${e.message}`));
        ws.close();
      }
    };
    ws.onclose = ({ code }) => ended.reject(new Error(`the mail service ended its stream (${code})`));
    try {
      return await ended.promise;
    } finally {
      clearInterval(beat);
    }
  });
}

/**
 * Mails `words`, with `files`, from email door `set`'s mailbox to its person alone, under `id`, which the mail
 * service sends once however often it is tried: as a reply to `last`, the person's last mail, or before they
 * have written at any door, as a new mail whose subject is its first line. It carries the words as they were
 * written and as HTML, so a mail client shows them formatted.
 */
async function mailOut(
  c: Coworker,
  set: Door,
  last: Event | null,
  id: string,
  words: string,
  files: string[],
) {
  const attachments = files.map((f) => ({
    filename: basename(f),
    content_type: Bun.file(f).type,
    content: readFileSync(f).toString("base64"),
  }));
  const to = [secret(c.setup, set.auth as string)];
  const [path, subject] = last
    ? [`/messages/${encodeURIComponent(last.ref)}/reply`, undefined]
    : ["/messages/send", words.split("\n")[0]?.slice(0, 78)];
  await mail(c, set, path, { to, subject, text: words, html: mailHtml(words), attachments }, id);
}

/**
 * `words`, the markdown a coworker writes, as plain HTML a mail client shows in its own font: bold, lists,
 * links and tables as themselves, each line break kept as it reads in chat, and any HTML in them shown as text.
 * A table has a thin border and padded cells, which is all the HTML says about how anything looks.
 */
const mailHtml = (words: string) =>
  // Two spaces before a line's end are markdown's line break; Bun 1.4.4's hardSoftBreaks does not change its HTML.
  Bun.markdown
    .html(words.replace(/(?<=[^\n])\n(?=[^\n])/g, "  \n"), {
      noHtmlBlocks: true,
      noHtmlSpans: true,
      autolinks: true,
    })
    // A table with no border or padding draws cramped in desktop mail clients. Every <table> here is the
    // renderer's own, since HTML in the words is shown as text.
    .replaceAll(
      "<table>",
      '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse: collapse">',
    );

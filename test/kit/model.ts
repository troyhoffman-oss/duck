import { LOCAL, latch, type Reach, reachedIn, Trouble } from "./reach";

type Json = Record<string, unknown>;

/** A content block the scripted model answers with. */
export type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Json };

/** What one rule answers: blocks, or an error, after an optional hold, or held part way. */
export type Reply = {
  content: Block[];
  error?: { status: number; type: string; message: string };
  hold?: string;
  midway?: string;
};

let toolIds = 0;

/** A reply of plain text. */
export const say = (text: string): Reply => ({ content: [{ type: "text", text }] });

/** A reply that calls tool `name` with `input`. */
export const call = (name: string, input: Json = {}): Reply => ({
  content: [{ type: "tool_use", id: `toolu_kit_${++toolIds}`, name, input }],
});

/** One reply made of several: their blocks in order. */
export const both = (...replies: Reply[]): Reply => ({ content: replies.flatMap((r) => r.content) });

/** `reply`, sent only once the test calls `release(name)`. */
export const held = (name: string, reply: Reply): Reply => ({ ...reply, hold: name });

/** `reply`, begun at once and finished only once the test calls `release(name)`. */
export const midway = (name: string, reply: Reply): Reply => ({ ...reply, midway: name });

/** An error in the Messages API's own shape. */
export const failure = (status: number, type: string, message: string): Reply => ({
  content: [],
  error: { status, type, message },
});

/**
 * One request as the scripted model received it: a Messages API request, or a decisions API request, which
 * shows its questions as its system text and its state as its one user message.
 */
export class ModelRequest {
  readonly model: string;
  readonly stream: boolean;
  readonly system: string;
  readonly messages: { role: string; content: unknown }[];
  readonly tools: string[];
  readonly started = performance.now();
  ended: number | null = null;
  /** Whether the caller hung up before it was answered. */
  cancelled = false;

  constructor(
    readonly body: Json,
    readonly headers: Headers,
  ) {
    this.model = String(body.model ?? "");
    this.stream = body.stream === true;
    this.system = textOf(body.system) || (body.questions ? JSON.stringify(body.questions) : "");
    this.messages = Array.isArray(body.messages)
      ? (body.messages as ModelRequest["messages"])
      : body.state === undefined
        ? []
        : [{ role: "user", content: body.state }];
    this.tools = Array.isArray(body.tools) ? body.tools.map((t: Json) => String(t.name)) : [];
  }

  /**
   * The text of the last user message, tool results included, without the turn-context blocks that say the time,
   * which goose and duck's model relay add (SPEC part 12).
   */
  get last(): string {
    const last = this.messages.findLast((m) => m.role === "user");
    const content = Array.isArray(last?.content)
      ? (last.content as Json[]).filter((b) => !String(b.text ?? "").startsWith("<turn-context>"))
      : last?.content;
    return textOf(content);
  }

  /** Every text the model is shown, in order: the system text, then each message. */
  get shown(): string {
    return [this.system, ...this.messages.map((m) => textOf(m.content))].join("\n");
  }

  /**
   * The name the request offers tool `name` under: itself, or as goose names an extension's tool,
   * `<extension>__<name>` (crates/goose/src/agents/extension_manager/mod.rs:363 at 1.59.0).
   */
  offered(name: string): string | undefined {
    if (this.tools.includes(name)) return name;
    const prefixed = this.tools.filter((t) => t.endsWith(`__${name}`));
    return prefixed.length === 1 ? prefixed[0] : undefined;
  }

  /** Whether the request offers tool `name`. */
  has(name: string): boolean {
    return this.offered(name) !== undefined;
  }

  /** Whether the last user message carries the result of a call to `tool`. */
  answers(tool: string): boolean {
    const [before, last] = this.messages.slice(-2);
    if (!before || !last || before.role !== "assistant" || !Array.isArray(before.content)) return false;
    const named = (n: unknown) => n === tool || String(n).endsWith(`__${tool}`);
    const ids = new Set(
      (before.content as Json[]).filter((b) => b.type === "tool_use" && named(b.name)).map((b) => b.id),
    );
    return Array.isArray(last.content) && (last.content as Json[]).some((b) => ids.has(b.tool_use_id));
  }

  /** Whether `text` is anywhere in what the model is shown. */
  shows(text: string): boolean {
    return this.shown.includes(text);
  }

  /** A line that names the request in a failure. */
  describe(): string {
    const last = this.last.replace(/\s+/g, " ").slice(-200);
    return `model ${this.model}, ${this.messages.length} messages, tools [${this.tools.slice(0, 8).join(", ")}${this.tools.length > 8 ? ", …" : ""}], last user text "${last}"`;
  }
}

/** Every string inside a system field or a message's content, joined. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const block = value as Json;
    if (typeof block.text === "string") return block.text;
    if ("content" in block) return textOf(block.content);
    if (block.type === "tool_use") return `${block.name} ${JSON.stringify(block.input)}`;
  }
  return "";
}

/** A predicate over a request. */
export type When = (request: ModelRequest) => boolean;

/** A request whose last user message holds `text`. */
export const said =
  (text: string): When =>
  (r) =>
    r.last.includes(text);
/** A request that shows `text` anywhere. */
export const shows =
  (text: string): When =>
  (r) =>
    r.shows(text);
/** A request that shows nothing of `text`. */
export const lacks =
  (text: string): When =>
  (r) =>
    !r.shows(text);
/** A request whose last user message answers a call to `tool`. */
export const answered =
  (tool: string): When =>
  (r) =>
    r.answers(tool);
/** A request every one of `whens` matches. */
export const all =
  (...whens: When[]): When =>
  (r) =>
    whens.every((w) => w(r));

type Rule = { when: When; reply: Reply | ((r: ModelRequest) => Reply); times: number; used: number };

/**
 * An HTTP server that speaks the Messages API as goose calls it, answering from the test's script: an
 * ordered list of rules, the first that matches and has uses left answering. A request no rule matches is
 * answered with an error, recorded as trouble, and fails the test that waits next. With `key`, a request
 * must carry it as `x-api-key`. With `decisions`, it also serves a decisions API at POST /decisions, whose
 * requests carry that key as a bearer and are answered from the same script (`decided`).
 */
export function scriptedModel({
  reach = LOCAL,
  key,
  decisions,
  trouble = new Trouble(),
}: {
  reach?: Reach;
  key?: string;
  decisions?: string;
  trouble?: Trouble;
} = {}) {
  const rules: Rule[] = [];
  const requests: ModelRequest[] = [];
  const holds = new Map<string, ReturnType<typeof latch>>();
  const reached = new Map<string, ReturnType<typeof latch>>();
  const holdOf = (map: typeof holds, name: string) => {
    let l = map.get(name);
    if (!l) {
      l = latch();
      map.set(name, l);
    }
    return l;
  };
  let messageIds = 0;

  async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const decision = decisions !== undefined && url.pathname === "/decisions";
    const right = decision
      ? request.headers.get("authorization") === `Bearer ${decisions}`
      : key === undefined || request.headers.get("x-api-key") === key;
    if (!right) return apiError(401, "authentication_error", "the scripted model was given a wrong key");
    if (request.method === "GET" && url.pathname === "/v1/models") {
      const ids = [...new Set(requests.map((r) => r.model))];
      return Response.json({
        data: ids.map((id) => ({ type: "model", id, display_name: id })),
        has_more: false,
      });
    }
    if (request.method !== "POST" || !(decision || url.pathname === "/v1/messages"))
      return apiError(
        404,
        "not_found_error",
        `the scripted model serves POST /v1/messages and /decisions only`,
      );
    const asked = new ModelRequest((await request.json()) as Json, request.headers);
    request.signal.addEventListener("abort", () => {
      if (asked.ended !== null) return;
      asked.cancelled = true;
      asked.ended = performance.now();
    });
    const previous = requests.findLast((r) => r.model === asked.model);
    requests.push(asked);
    const rule = rules.find((r) => r.used < r.times && r.when(asked));
    if (!rule) {
      const problem = new Error(`no rule of the scripted model matches the request: ${asked.describe()}`);
      trouble.add(problem);
      asked.ended = performance.now();
      return apiError(400, "invalid_request_error", problem.message);
    }
    rule.used++;
    const reply = typeof rule.reply === "function" ? rule.reply(asked) : rule.reply;
    if (reply.hold !== undefined) {
      holdOf(reached, reply.hold).open();
      await holdOf(holds, reply.hold).opened;
    }
    if (reply.error) {
      asked.ended = performance.now();
      return apiError(reply.error.status, reply.error.type, reply.error.message);
    }
    const content: Block[] = [];
    for (const block of reply.content) {
      if (block.type !== "tool_use") {
        content.push(block);
        continue;
      }
      const name = asked.offered(block.name);
      if (name === undefined) {
        const problem = new Error(
          `the script calls ${block.name}, which the request does not offer: ${asked.describe()}`,
        );
        trouble.add(problem);
        asked.ended = performance.now();
        return apiError(400, "invalid_request_error", problem.message);
      }
      content.push({ ...block, name });
    }
    if (decision) {
      asked.ended = performance.now();
      return Response.json(decided(asked, content));
    }
    const message = {
      id: `msg_kit_${++messageIds}`,
      type: "message",
      role: "assistant",
      model: asked.model,
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: usageOf(asked, previous, content),
    };
    const whole = asked.stream ? streamOf(message) : Response.json(message);
    if (reply.midway === undefined) {
      asked.ended = performance.now();
      return whole;
    }
    // The first event, or half the message, now; the rest on release, unless the caller hung up first.
    const text = await whole.text();
    const cut = asked.stream ? text.indexOf("\n\n") + 2 : text.length >> 1;
    const rest = holdOf(holds, reply.midway).opened;
    let parts = 0;
    const body = new ReadableStream({
      async pull(c) {
        // Reached once the answer is on its way: its headers sent and its first part with them.
        if (parts++ === 0) {
          c.enqueue(new TextEncoder().encode(text.slice(0, cut)));
          return holdOf(reached, reply.midway as string).open();
        }
        await rest;
        if (asked.cancelled) return;
        asked.ended = performance.now();
        c.enqueue(new TextEncoder().encode(text.slice(cut)));
        c.close();
      },
    });
    return new Response(body, { headers: whole.headers });
  }

  const server = Bun.serve({
    hostname: reach.bind,
    port: 0,
    idleTimeout: 0,
    fetch: answer,
  });

  return {
    url: `http://${reach.host}:${server.port}`,
    requests,
    trouble,
    /** Adds a rule after those already given. It answers `times` requests, once by default. */
    on(when: When, reply: Reply | ((r: ModelRequest) => Reply), { times = 1 }: { times?: number } = {}) {
      rules.push({ when, reply, times, used: 0 });
    },
    /** Lets every request held at `name` be answered. */
    release(name: string) {
      holdOf(holds, name).open();
    },
    /** Resolves once a request reaches the hold `name`, within 60 s and before any trouble. */
    reached(name: string): Promise<void> {
      return reachedIn(`a request held at ${name}`, holdOf(reached, name), trouble);
    },
    /** Fails naming each rule given a number of uses that it did not use up. */
    check() {
      const left = rules.filter((r) => r.used < r.times && Number.isFinite(r.times));
      const said = (r: Rule) =>
        typeof r.reply === "function"
          ? "a reply made from its request"
          : JSON.stringify(r.reply.content).slice(0, 120);
      if (left.length > 0)
        throw new Error(`rules of the scripted model never used: ${left.map(said).join("; ")}`);
    },
    /** Forgets every rule and request, and lets every held answer go, for the next step. */
    clear() {
      rules.length = 0;
      requests.length = 0;
      for (const l of holds.values()) l.open();
      holds.clear();
      reached.clear();
    },
    stop: () => server.stop(true),
  };
}

export type ScriptedModel = ReturnType<typeof scriptedModel>;

/** The most of `requests` that were being answered at one moment. */
export function atOnce(requests: ModelRequest[]): number {
  const edges = requests.flatMap((r) => [
    { at: r.started, step: 1 },
    { at: r.ended ?? Number.POSITIVE_INFINITY, step: -1 },
  ]);
  edges.sort((a, b) => a.at - b.at || a.step - b.step);
  let now = 0;
  let most = 0;
  for (const edge of edges) {
    now += edge.step;
    most = Math.max(most, now);
  }
  return most;
}

/**
 * A decisions API answer read from a scripted text reply. Each choice question answers the text's first word
 * at 0.9, its other answers sharing the rest, or refuses when the word is not one of its answers. Each yes/no
 * question answers 0.9 where the text says "addresses AI", the label SPEC part 4 names, and 0.1 where not.
 */
function decided(asked: ModelRequest, content: Block[]) {
  const text = content.map((b) => (b.type === "text" ? b.text : "")).join("");
  const word = /^\W*(\w+)/.exec(text)?.[1] ?? "";
  const questions = asked.body.questions as Record<string, { type: string; criteria?: Json }>;
  const answers = Object.entries(questions).map(([name, q]) => {
    if (q.type === "noul") {
      const noul = text.includes("addresses AI") ? 0.9 : 0.1;
      return [name, { type: "noul", noul, confidence: Math.max(noul, 1 - noul) }];
    }
    const options = Object.keys(q.criteria ?? {});
    if (!options.includes(word)) return [name, { type: "refusal" }];
    const probabilities = Object.fromEntries(
      options.map((o) => [o, o === word ? 0.9 : 0.1 / (options.length - 1)]),
    );
    return [name, { type: "choice", choice: word, probabilities, confidence: 0.9 }];
  });
  const usage = { input_tokens: Math.ceil(asked.shown.length / 4), output_tokens: answers.length };
  return { model: asked.model, answers: Object.fromEntries(answers), usage };
}

const apiError = (status: number, type: string, message: string) =>
  Response.json({ type: "error", error: { type, message } }, { status });

/**
 * Usage as the API reports it, cache fields included: what the request shares from its start with the
 * model's previous request counts as read from cache and the rest as written to it, at four characters a
 * token, so a test can see a prompt whose start changed between calls. No input is left uncached but one
 * token, as with a cache breakpoint on the last message.
 */
function usageOf(asked: ModelRequest, previous: ModelRequest | undefined, content: Block[]) {
  const now = JSON.stringify([asked.body.system, asked.body.tools, asked.body.messages]);
  const before = previous
    ? JSON.stringify([previous.body.system, previous.body.tools, previous.body.messages])
    : "";
  let shared = 0;
  while (shared < now.length && shared < before.length && now[shared] === before[shared]) shared++;
  const tokens = (chars: number) => Math.ceil(chars / 4);
  return {
    input_tokens: 1,
    cache_read_input_tokens: tokens(shared),
    cache_creation_input_tokens: tokens(now.length - shared),
    output_tokens: Math.max(1, tokens(JSON.stringify(content).length)),
  };
}

/** A message as the API streams it: server-sent events, one block after another. */
function streamOf(message: Json & { content: Block[]; usage: Json }) {
  const events: [string, Json][] = [
    ["message_start", { message: { ...message, content: [], stop_reason: null, usage: message.usage } }],
  ];
  message.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { index, content_block: { ...block, input: {} } }]);
      events.push([
        "content_block_delta",
        { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
      ]);
    }
    events.push(["content_block_stop", { index }]);
  });
  events.push([
    "message_delta",
    {
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: message.usage.output_tokens },
    },
  ]);
  events.push(["message_stop", {}]);
  const body = events
    .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

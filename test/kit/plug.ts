import { createHmac } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LOCAL, latch, type Reach, reachedIn, Trouble } from "./reach";

type Json = Record<string, unknown>;

/**
 * One tool a test declares: what it is for, its input's JSON schema, and what it answers: an MCP result, as
 * one with `content` is, or else the text of one.
 */
export type PlugTool = {
  description?: string;
  input?: Json;
  answer?: (input: Json) => unknown;
};

/** An event in the shape every plug's events reach the inbox in (SPEC part 1, Plugs), and the person it names, if any. */
export type PlugEvent = {
  source: string;
  ref: string;
  about?: string;
  received_at: string;
  payload: Json;
  person?: string;
};

/** A call the plug was given. */
export type PlugCall = { tool: string; input: Json; at: number; headers: Headers };

/**
 * A plug: an MCP server over streamable HTTP at `url`, with the tools the test declares. It records every
 * call, can hold a tool's calls until the test releases them, and pushes events to duck as a source that
 * can push does. With `keys`, a request must carry one of them as a bearer token: those given, or those the
 * function gives at the time, as a plug that takes each person's sign-in does.
 */
export function startPlug({
  name,
  tools,
  reach = LOCAL,
  keys,
  trouble = new Trouble(),
}: {
  name: string;
  tools: Record<string, PlugTool>;
  reach?: Reach;
  keys?: string[] | (() => string[]);
  trouble?: Trouble;
}) {
  const calls: PlugCall[] = [];
  const holds = new Map<string, { reached: ReturnType<typeof latch>; open: ReturnType<typeof latch> }>();
  /** Answers a step gives a tool in place of its own, until the step ends. */
  const answers = new Map<string, PlugTool["answer"]>();

  function serverFor(headers: Headers) {
    const server = new Server({ name, version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: Object.entries(tools).map(([tool, t]) => ({
        name: tool,
        description: t.description ?? tool,
        inputSchema: t.input ?? { type: "object" },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const tool = tools[params.name];
      if (!tool) return { isError: true, content: [{ type: "text", text: `no tool ${params.name}` }] };
      const input = (params.arguments ?? {}) as Json;
      calls.push({ tool: params.name, input, at: performance.now(), headers });
      const hold = holds.get(params.name);
      if (hold) {
        hold.reached.open();
        await hold.open.opened;
      }
      const answer = await (answers.get(params.name) ?? tool.answer ?? (() => "done"))(input);
      if (answer && typeof answer === "object" && "content" in answer) return answer;
      return {
        content: [{ type: "text", text: typeof answer === "string" ? answer : JSON.stringify(answer) }],
      };
    });
    return server;
  }

  const http = Bun.serve({
    hostname: reach.bind,
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      const taken = typeof keys === "function" ? keys() : keys;
      if (taken !== undefined && !taken.some((k) => request.headers.get("authorization") === `Bearer ${k}`))
        return new Response("wrong key", { status: 401 });
      // Stateless, so each request gets a server of its own, as the SDK asks.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await serverFor(request.headers).connect(transport);
      return transport.handleRequest(request);
    },
  });

  return {
    name,
    url: `http://${reach.host}:${http.port}/mcp`,
    calls,
    /** The calls to `tool`. */
    callsTo: (tool: string) => calls.filter((c) => c.tool === tool),
    /** Holds every call to `tool` from now until `release(tool)`. */
    hold(tool: string) {
      holds.set(tool, { reached: latch(), open: latch() });
    },
    /** Resolves once a call to the held `tool` arrives, within 60 s and before any trouble. */
    reached: (tool: string) =>
      reachedIn(
        `a call to ${tool}`,
        (holds.get(tool) as { reached: ReturnType<typeof latch> }).reached,
        trouble,
      ),
    release(tool: string) {
      holds.get(tool)?.open.open();
      holds.delete(tool);
    },
    /** Answers calls to `tool` with `answer` in place of its own until `clear`. */
    answer(tool: string, answer: PlugTool["answer"]) {
      answers.set(tool, answer);
    },
    /** Forgets the calls and the answers given, and lets every held call go, for the next step. */
    clear() {
      calls.length = 0;
      for (const tool of [...holds.keys()]) this.release(tool);
      answers.clear();
    },
    /**
     * Posts `event` to duck's inbox handler at `address` as this plug, with the plug's push key as a bearer
     * token, or `signed`, with the hex HMAC-SHA256 of the body made with it in `x-signature`, and returns
     * duck's answer.
     */
    async push(
      address: string,
      pushKey: string,
      event: Omit<PlugEvent, "source" | "received_at"> & Partial<PlugEvent>,
      signed = false,
    ) {
      const body = JSON.stringify({ source: name, received_at: new Date().toISOString(), ...event });
      const proof: Record<string, string> = signed
        ? { "x-signature": createHmac("sha256", pushKey).update(body).digest("hex") }
        : { authorization: `Bearer ${pushKey}` };
      const response = await fetch(`${address}/events/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...proof },
        body,
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as Json | null };
    },
    stop: () => http.stop(true),
  };
}

export type Plug = ReturnType<typeof startPlug>;

/** A list tool for a polled source: it answers with the rows of `rows` as they are at each call. */
export const listTool = (rows: Json[], description = "Lists what is new."): PlugTool => ({
  description,
  answer: () => rows,
});

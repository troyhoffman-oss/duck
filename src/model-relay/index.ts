import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { type Setup, secret } from "../setup";
import { claudeLogin } from "./claude-login";

/** One way to reach the firm's model: a Messages API request in, the provider's answer out. */
type Route = (setup: Setup, path: string, init: RequestInit) => Promise<Response>;

/** The routes a firm picks from in setup's `model.route` (SPEC part 12). */
export const routes: Record<string, Route> = {
  "api-key": (setup, path, init) =>
    fetch(`${(setup.model.address ?? "").replace(/\/+$/, "")}${path}`, {
      ...init,
      // A redirect would carry the firm's key to wherever it points.
      redirect: "error",
      headers: {
        ...(init.headers as Record<string, string>),
        "x-api-key": secret(setup, setup.model.key ?? ""),
      },
    }),
  // goose also asks for the list of models, which `claude` cannot give.
  "claude-login": async (setup, path, init) =>
    path.startsWith("/v1/messages")
      ? claudeLogin(setup.model.login ?? "", init)
      : new Response("the claude-login route serves POST /v1/messages only", { status: 404 }),
};

/**
 * USD per million tokens: input, cache write for five minutes, cache read, output. A cache write for an hour
 * costs twice the input. From the claude-api skill's model and caching references, read 2026-11-17.
 */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-fable-5-2": [8, 10, 0.2, 40],
  "claude-opus-5-5": [4, 5, 0.2, 20],
  "claude-sonnet-5-5": [2, 2.5, 0.1, 10],
  "claude-haiku-5-5": [0.1, 0.125, 0.01, 0.5],
};

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number };
};

/** The usage a Messages API answer reports, whether streamed or whole; an error, or no usage, throws. */
function usageOf(answer: string): Usage {
  const usage: Usage = {};
  const parts = answer.startsWith("{")
    ? [answer]
    : answer
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6));
  for (const part of parts) {
    const event = JSON.parse(part) as {
      usage?: Usage;
      message?: { usage?: Usage };
      error?: { message: string };
    };
    if (event.error) throw new Error(event.error.message);
    Object.assign(usage, event.message?.usage, event.usage);
  }
  if (usage.output_tokens === undefined) throw new Error("the answer reports no usage");
  return usage;
}

/**
 * The model relay: serves the Messages API to a call from the firm's coworker `coworker`, logs it, and tells
 * `spent` the session it came from and what it cost.
 */
export function modelRelay(setup: Setup) {
  const route = routes[setup.model.route] as Route;
  return async (request: Request, coworker: string, spent: (session: string, cost: number) => void) => {
    const started = performance.now();
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.text() : undefined;
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const name of ["anthropic-version", "anthropic-beta"]) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    const model = body === undefined ? undefined : (JSON.parse(body) as { model?: string }).model;
    const log = (status: number, u: Usage, failed?: Error) => {
      const [read, wrote] = [u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
      const tokens = (u.input_tokens ?? 0) + read + wrote;
      const p = PRICES[model ?? ""];
      const session = request.headers.get("agent-session-id");
      const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const cost =
        p &&
        ((u.input_tokens ?? 0) * p[0] +
          (wrote - hour) * p[1] +
          hour * 2 * p[0] +
          read * p[2] +
          (u.output_tokens ?? 0) * p[3]) /
          1e6;
      console.log(
        JSON.stringify({
          relay: coworker,
          session,
          model,
          status,
          in: tokens,
          out: u.output_tokens ?? 0,
          cached: tokens ? Math.round((read / tokens) * 1000) / 1000 : 0,
          cost: cost ?? null,
          wait_ms: Math.round(performance.now() - started),
          failed: failed?.message.split("\n")[0],
        }),
      );
      if (session) spent(session, cost ?? 0);
    };
    const answer = await route(setup, url.pathname + url.search, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
    }).catch((error: Error) => error);
    if (answer instanceof Error) {
      log(0, {}, answer);
      return new Response(answer.message, { status: 502 });
    }
    const type = { "content-type": answer.headers.get("content-type") ?? "application/json" };
    if (!answer.body || body === undefined)
      return new Response(answer.body, { status: answer.status, headers: type });
    const [mine, theirs] = answer.body.tee();
    void new Response(mine)
      .text()
      .then((text) => log(answer.status, usageOf(text)))
      // An answer cut off, an error answer, and one that reports no usage are logged as failed, with no usage.
      .catch((error: Error) => log(answer.status, {}, error));
    return new Response(theirs, { status: answer.status, headers: type });
  };
}

/** The calendar month of `at` in time zone `zone`, as 2026-11. */
export const monthOf = (at: Date, zone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit" })
    .format(at)
    .slice(0, 7);

/** How far duck's log has been read, and each coworker's cost in the month it was read for. */
const tally = { month: "", read: 0, costs: new Map<string, number>() };

/**
 * Each coworker's cost in US dollars this calendar month in the firm's zone, summed from the model relay's line
 * per call in duck's log, the file podman keeps in storage (src/setup/install.ts). Each look reads only what
 * the log gained since the last; a new month reads it again from the start.
 */
export function monthCosts(setup: Setup): ReadonlyMap<string, number> {
  const file = join(setup.storage.folder, "duck.log");
  const month = monthOf(new Date(), setup.zone);
  const size = existsSync(file) ? statSync(file).size : 0;
  if (month !== tally.month || size < tally.read) Object.assign(tally, { month, read: 0, costs: new Map() });
  const fd = size > tally.read ? openSync(file, "r") : undefined;
  // In pieces, so a log of many months is never held whole.
  for (const piece = Buffer.alloc(1 << 22); fd !== undefined && tally.read < size; ) {
    const got = readSync(fd, piece, 0, Math.min(piece.length, size - tally.read), tally.read);
    const end = piece.subarray(0, got).lastIndexOf(10) + 1;
    if (end === 0) break;
    tally.read += end;
    // podman writes each line as its time, the stream, a flag and what duck printed.
    for (const line of piece.subarray(0, end).toString().split("\n")) {
      const [at = "", , , ...printed] = line.split(" ");
      const text = printed.join(" ");
      if (!text.startsWith('{"relay":')) continue;
      const { relay, cost } = JSON.parse(text) as { relay: string; cost: number | null };
      if (cost && monthOf(new Date(at.replace(/(\.\d{3})\d+/, "$1")), setup.zone) === month)
        tally.costs.set(relay, (tally.costs.get(relay) ?? 0) + cost);
    }
  }
  if (fd !== undefined) closeSync(fd);
  return tally.costs;
}

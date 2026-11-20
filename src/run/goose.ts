import { setTimeout as sleep } from "node:timers/promises";

/** A `session/update` from goose, in the fields duck reads. */
export type Update = {
  sessionUpdate: string;
  messageId?: string;
  content?: { type: string; text?: string };
  toolCallId?: string;
  title?: string;
  rawInput?: unknown;
  status?: string;
  _meta?: { goose?: { activeRunId?: string | null; inference?: unknown; toolCall?: { toolName: string } } };
};

type Reply = {
  id?: number;
  method?: string;
  params?: { sessionId: string; update: Update };
  result?: unknown;
  error?: { message: string };
};

// biome-ignore lint/suspicious/noExplicitAny: each method's result is read where it is called
export type Call = (method: string, params: object) => Promise<any>;

/**
 * goose's ACP server at `url`. Each connection is initialized, then `back` runs on it before any other call
 * goes; a call made while goose is away waits until it is back. A lost connection is logged once and fails
 * the calls it carried, and duck connects again, giving up a try not open in 5 s and trying after a wait
 * that doubles up to 5 s. `connected` settles once the first connection is up. Once `signal` aborts, the
 * connection closes, duck connects no more and every call fails.
 */
export function connect(
  url: string,
  update: (session: string, u: Update) => void,
  back: (call: Call) => Promise<unknown>,
  signal: AbortSignal,
) {
  const waiting = new Map<number, (m: Reply) => void>();
  let [ids, socket, up, isUp] = [0, undefined as WebSocket | undefined, Promise.withResolvers<void>(), false];
  const connected = up.promise;
  const stopped = Promise.withResolvers<never>();
  stopped.promise.catch(() => {});
  signal.addEventListener("abort", () => {
    const why = `goose at ${url}: its coworker stopped`;
    stopped.reject(new Error(why));
    for (const settle of waiting.values()) settle({ error: { message: why } });
  });
  const send = (message: object) => socket?.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  const raw: Call = (method, params) =>
    new Promise((ok, no) => {
      if (!socket) return no(new Error(`goose ${method}: goose is away`));
      const id = ++ids;
      waiting.set(id, (m) => {
        waiting.delete(id);
        if (m.error) no(new Error(`goose ${method}: ${m.error.message}`));
        else ok(m.result);
      });
      send({ id, method, params });
    });
  /** Opens a connection, and settles once it has closed: true if goose was up on it. */
  const open = () =>
    new Promise<boolean>((closed) => {
      const ws = new WebSocket(url);
      // bun's WebSocket gives up on no connection by itself, and one to the address a goose container had
      // before it started again hangs (measured on the fleet).
      const late = setTimeout(() => ws.close(), 5000);
      const end = () => ws.close();
      signal.addEventListener("abort", end);
      ws.onerror = () => socket !== ws && closed(false);
      ws.onopen = () => {
        clearTimeout(late);
        socket = ws;
        raw("initialize", { protocolVersion: 1, clientCapabilities: {} })
          .then(() => back(raw))
          .then(
            () => {
              // Only a connection after a lost one waits on a promise other than the first.
              if (up.promise !== connected) console.error(`goose at ${url} is back`);
              isUp = true;
              up.resolve();
            },
            (error: Error) => {
              console.error(`goose at ${url} answered but could not take up its work: ${error.message}`);
              ws.close();
            },
          );
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as Reply;
        if (m.method === "session/update" && m.params) update(m.params.sessionId, m.params.update);
        else if (m.method === undefined && m.id !== undefined) waiting.get(m.id)?.(m);
      };
      ws.onclose = (e) => {
        signal.removeEventListener("abort", end);
        clearTimeout(late);
        if (socket !== ws) return closed(false);
        socket = undefined;
        const why = `lost goose at ${url} (${e.code}${e.reason ? `: ${e.reason}` : ""})`;
        for (const settle of waiting.values()) settle({ error: { message: why } });
        if (isUp && !signal.aborted) {
          console.error(`${why}; duck connects again once it is back`);
          up = Promise.withResolvers();
        }
        closed(isUp);
        isUp = false;
      };
    });
  void (async () => {
    for (let wait = 250; !signal.aborted; await sleep(wait, undefined, { signal }).catch(() => {}))
      wait = (await open()) ? 250 : Math.min(wait * 2, 5000);
  })();
  const call: Call = async (method, params) => {
    await Promise.race([stopped.promise, up.promise]);
    return raw(method, params);
  };
  return {
    call,
    notify: (method: string, params: object) => send({ method, params }),
    connected,
    /** Whether goose is up now. */
    up: () => isUp,
  };
}

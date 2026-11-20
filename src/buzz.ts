import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

/** An identity in Buzz: its secret key in hex, its owner's NIP-OA auth tag as Buzz copies it, and its relay. */
export type Identity = { key: string; owner: string; relay: string };

/** A signed Nostr event, as the relay holds it. */
export type Event = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
};

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const now = () => Math.floor(Date.now() / 1000);
const tagOf = (event: Event, name: string) => event.tags.find((t) => t[0] === name)?.[1] ?? "";

/**
 * Event `kind` with `tags` and `content`, made at `created_at`, signed as `who` with its owner's tag, as Buzz's
 * CLI signs every event.
 */
function sign(who: Identity, created_at: number, kind: number, tags: string[][], content: string): Event {
  const secret = Buffer.from(who.key, "hex");
  const pubkey = hex(schnorr.getPublicKey(secret));
  const all = [...tags, JSON.parse(who.owner) as string[]];
  const id = createHash("sha256")
    .update(JSON.stringify([0, pubkey, created_at, kind, all, content]))
    .digest();
  return { id: hex(id), pubkey, created_at, kind, tags: all, content, sig: hex(schnorr.sign(id, secret)) };
}

/**
 * Holds `who`'s connection to its relay (NIP-42, with the owner's tag) and hands `handler` once each artifact
 * revision (kind 45010, NIP-AR) someone else writes, from when it starts, in a system channel (NIP-CL) the
 * relay's notices (44100, 44101) say `who` is in, asking again on each, since a subscription's channels are fixed
 * when sent. A notice names its channel's type, and the relay sends one of a system channel only to a filter
 * that names that type (buzz-relay src/handlers/side_effects.rs:1318-1327). It connects again when the relay goes, and 5
 * minutes after a refused sign-in, until closed. Returns what publishes an event as `who`, and `who`'s key.
 */
export function connect(who: Identity, handler: (revision: Event) => void) {
  const me = hex(schnorr.getPublicKey(Buffer.from(who.key, "hex")));
  const what = `the Buzz connection of ${me.slice(0, 8)}`;
  const started = now();
  /** When this connection last signed: each event a second past it at least, so two alike are two, in order. */
  let last = 0;
  const signed = (kind: number, tags: string[][], content: string) => {
    last = Math.max(now(), last + 1);
    return sign(who, last, kind, tags, content);
  };
  /** A writer's clock is not duck's: an ask reaches back as far as the relay takes a time (ingest.rs), 900 s. */
  const since = () => Math.max(started, now() - 900);
  /** Each system channel `who` is in. */
  const channels = new Set<string>();
  /** Each message handed on, by id, with when duck first saw it, kept 2,000 s, past its last ask again. */
  const seen = new Map<string, number>();
  let socket: WebSocket | undefined;
  let [current, closed] = [undefined as WebSocket | undefined, false];
  let signedIn = () => {};
  const ready = new Promise<void>((resolve) => (signedIn = resolve));
  /** Each event sent that waits on the relay's OK, by id, and the query that waits on its events. */
  const waiting = new Map<string, (taken: boolean, message: string) => void>();
  let found: { events: Event[]; done: (events: Event[]) => void; fail: (error: Error) => void } | undefined;
  const open = () => {
    const ws = new WebSocket(who.relay);
    current = ws;
    let [signIn, wait] = ["", 5000];
    let notices: Event[] | undefined = [];
    const send = (...frame: unknown[]) => ws.send(JSON.stringify(frame));
    const listen = () =>
      channels.size > 0
        ? send("REQ", "messages", { kinds: [45010], "#h": [...channels], since: since() })
        : send("CLOSE", "messages");
    const notice = (n: Event) =>
      n.kind === 44100 ? channels.add(tagOf(n, "h")) : channels.delete(tagOf(n, "h"));
    const take = (type: string, a: string, b: Event & boolean, c: string) => {
      if (type === "AUTH") {
        const auth = signed(22242, Object.entries({ relay: who.relay, challenge: a }), "");
        signIn = auth.id;
        send("AUTH", auth);
      } else if (type === "OK" && a === signIn) {
        if (b !== true) {
          console.error(`${what} was refused, so it tries again in 5 minutes: ${c}`);
          wait = 300_000;
          return ws.close();
        }
        socket = ws;
        signedIn();
        send("REQ", "notices", { kinds: [44100, 44101], "#p": [me], "#t": ["system"] });
      } else if (type === "OK") waiting.get(a)?.(b === true, c);
      else if (type === "EVENT" && a === "query") found?.events.push(b);
      else if (type === "EOSE" && a === "query") {
        send("CLOSE", "query");
        found?.done(found.events);
      } else if (type === "CLOSED" && a === "query")
        found?.fail(new Error(`the relay refused the query: ${b}`));
      else if (type === "EOSE" && a === "notices" && notices) {
        for (const n of notices.sort((x, y) => x.created_at - y.created_at)) notice(n);
        notices = undefined;
        listen();
      } else if (type === "EVENT" && a === "notices" && notices) notices.push(b);
      else if (type === "EVENT" && a === "notices") {
        notice(b);
        listen();
      } else if (type === "EVENT" && a === "messages") {
        if (seen.has(b.id) || b.pubkey === me || !channels.has(tagOf(b, "h"))) return;
        seen.set(b.id, now());
        for (const [id, at] of seen) if (at < now() - 2000) seen.delete(id);
        handler(b);
      }
    };
    // A frame is [type, a, b, c], `b` an event or, in an OK, whether the relay took it. One that cannot be read
    // must not end the process, which holds every coworker's runs.
    ws.onmessage = (m) => {
      try {
        take(...(JSON.parse(String(m.data)) as Parameters<typeof take>));
      } catch (e) {
        console.error(`${what} could not take a frame from the relay: ${(e as Error).message}`);
      }
    };
    ws.onclose = () => {
      if (socket === ws) {
        socket = undefined;
        for (const done of waiting.values()) done(false, "the relay went");
        console.error(`${what} lost the relay; it connects again in 5 s`);
      }
      if (!closed) setTimeout(open, wait);
    };
  };
  open();

  return {
    me,
    /**
     * Publishes event `kind` with `tags` and `content` as `who` once signed in: the relay's OK message, or its
     * reason, or that it gave none in 10 s, so a relay that never answers holds no caller.
     */
    send: async (kind: number, tags: string[][], content: string) => {
      await ready;
      return new Promise<string>((resolve, reject) => {
        const event = signed(kind, tags, content);
        if (!socket) return reject(new Error(`${what} is not connected`));
        const timer = setTimeout(
          () => waiting.get(event.id)?.(false, "the relay gave no answer in 10 s"),
          10_000,
        );
        waiting.set(event.id, (taken, message) => {
          clearTimeout(timer);
          waiting.delete(event.id);
          taken ? resolve(message) : reject(new Error(message));
        });
        socket.send(JSON.stringify(["EVENT", event]));
      });
    },
    /** The events the relay holds that match `filter`, once signed in, or its refusal; one query at a time. */
    query: async (filter: object) => {
      await ready;
      return new Promise<Event[]>((done, fail) => {
        found = { events: [], done, fail };
        socket?.send(JSON.stringify(["REQ", "query", filter]));
      });
    },
    /** Ends the connection for good. */
    close: () => {
      closed = true;
      current?.close();
    },
  };
}

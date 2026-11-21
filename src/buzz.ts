import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

/** An identity in Buzz: its secret key in hex, its relay, and for an agent, its owner's NIP-OA auth tag. */
export type Identity = { key: string; relay: string; owner?: string };

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
 * Event `kind` with `tags` and `content`, made at `created_at`, signed as `who`, with its owner's tag where it
 * is an agent, as Buzz's CLI signs every event of one.
 */
export function sign(
  who: Identity,
  created_at: number,
  kind: number,
  tags: string[][],
  content: string,
): Event {
  const secret = Buffer.from(who.key, "hex");
  const pubkey = hex(schnorr.getPublicKey(secret));
  const all = who.owner ? [...tags, JSON.parse(who.owner) as string[]] : tags;
  const id = createHash("sha256")
    .update(JSON.stringify([0, pubkey, created_at, kind, all, content]))
    .digest();
  return { id: hex(id), pubkey, created_at, kind, tags: all, content, sig: hex(schnorr.sign(id, secret)) };
}

/**
 * What a connection hands on: events of `kinds` in the channels the relay's record `channels` lists for a key,
 * each a channel by its `d` tag, with the label `label` gives it, or none where it is not one; asked again at
 * each notice `notices` lists, since a subscription's channels are fixed when sent. A channel a notice adds the
 * key to (44100, its `h` tag) is one, labelled `added`, until a notice removes it (44101), where `added` names
 * a label: the relay writes its record of members after that notice (side_effects.rs:2196-2219).
 */
type Channels = {
  kinds: number[];
  channels: (me: string) => object;
  label: (channel: Event, me: string) => string | undefined;
  notices: (me: string) => object;
  added?: string;
};

/**
 * The artifact revisions (kind 45010, NIP-AR) in each system channel (NIP-CL) a key made, by the relay's own
 * record of them (39000, which no client writes), labelled as their second `t` tag, after their type. The relay
 * sends a notice of a system channel only to a filter that names that type (buzz-relay
 * src/handlers/side_effects.rs:1318-1327).
 */
export const SYSTEM: Channels = {
  kinds: [45010],
  channels: (me) => ({ kinds: [39000], "#P": [me], "#t": ["system"] }),
  label: (c, me) =>
    tagOf(c, "t") === "system" && tagOf(c, "P") === me
      ? (c.tags.filter((t) => t[0] === "t")[1]?.[1] ?? "")
      : undefined,
  notices: (me) => ({ kinds: [44100, 44101], "#p": [me], "#t": ["system"] }),
};

/** The starts and ends of calls (kinds 48100, 48103) in every channel a key is a member of (39002, 44100). */
export const MEMBER: Channels = {
  kinds: [48100, 48103],
  channels: (me) => ({ kinds: [39002], "#p": [me] }),
  label: () => "",
  notices: (me) => ({ kinds: [44100, 44101], "#p": [me] }),
  added: "",
};

/**
 * Holds `who`'s connection to its relay (NIP-42) and hands `handler` once each event someone else writes of
 * the kinds `listened` names, from when it starts, in a channel it names (by default, the artifact revisions
 * in each system channel `who` made), with that channel's label. The channels are asked again at each sign-in
 * and each membership notice to `who`; a notice's content decides nothing.
 * Events the relay holds from before a subscription's end of stored events come oldest first, as written. It
 * connects again when the relay goes, until closed, and after a refused sign-in, logged when its reason is new,
 * in 5 minutes, or in one, telling `notMember`, where `who` is not on the member list. Returns what publishes
 * an event as `who`, what asks the relay, and the channel `who` made for a label.
 */
export function connect(
  who: Identity,
  handler: (event: Event, label: string) => void,
  notMember = () => {},
  listened = SYSTEM,
) {
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
  /** Each channel listened in, by id, with its label and when it was made, as the relay last said. */
  let made = new Map<string, { label: string; at: number }>();
  /** Each channel a notice since this connection started added `who` to and none removed, with when. */
  const added = new Map<string, number>();
  /** Each message handed on, by id, with when duck first saw it, kept 2,000 s, past its last ask again. */
  const seen = new Map<string, number>();
  let socket: WebSocket | undefined;
  let [current, closed] = [undefined as WebSocket | undefined, false];
  let [signedIn, refused] = [() => {}, ""];
  let ready = new Promise<void>((resolve) => (signedIn = resolve));
  /** Signed in now or within 10 s, so nothing waits on a relay that is gone. */
  const soon = () =>
    new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`${what} is not signed in`)), 10_000);
      ready.then(() => done(clearTimeout(timer)));
    });
  /** Each event sent that waits on the relay's OK, by id. */
  const waiting = new Map<string, (taken: boolean, message: string) => void>();
  // The query the relay answers now. Each has an id of its own: the relay answers a CLOSE with CLOSED
  // (buzz-relay src/handlers/close.rs:22), which must not end the query after it.
  let found: { id: string; events: Event[]; end: (error?: Error) => void } | undefined;
  let [ids, line] = [0, Promise.resolve()];
  /** The events the relay holds that match `filter`, or why not, in 10 s once signed in; one at a time. */
  const query = (filter: object) => {
    const asked = line.then(soon).then(
      () =>
        new Promise<Event[]>((done, fail) => {
          const [id, events] = [`query-${++ids}`, [] as Event[]];
          const timer = setTimeout(() => found?.end(new Error("the relay gave no answer in 10 s")), 10_000);
          found = {
            id,
            events,
            end: (error) => {
              clearTimeout(timer);
              found = undefined;
              socket?.send(JSON.stringify(["CLOSE", id]));
              error ? fail(error) : done(events);
            },
          };
          socket?.send(JSON.stringify(["REQ", id, filter]));
        }),
    );
    line = asked.then(
      () => {},
      () => {},
    );
    return asked;
  };
  /** The subscription to the channels' messages, and what it holds back until the relay's end of stored events. */
  let [listening, held] = ["", undefined as Event[] | undefined];
  const listen = () => {
    if (listening) socket?.send(JSON.stringify(["CLOSE", listening]));
    [listening, held] = [`messages-${++ids}`, []];
    const filter = { kinds: listened.kinds, "#h": [...made.keys()], since: since() };
    if (made.size > 0) socket?.send(JSON.stringify(["REQ", listening, filter]));
  };
  const hand = (b: Event) => {
    const label = made.get(tagOf(b, "h"))?.label;
    if (seen.has(b.id) || b.pubkey === me || label === undefined) return;
    seen.set(b.id, now());
    for (const [id, at] of seen) if (at < now() - 2000) seen.delete(id);
    handler(b, label);
  };
  /**
   * Asks the relay again which channels `who` listens in, page by page back to the first, since it answers
   * newest first up to its page limit (buzz-relay src/handlers/req.rs:1324, 1360-1364): a page short of it, or
   * with nothing new, is the last. Then it listens to them.
   */
  const sync = async () => {
    const all = new Map<string, Event>();
    for (let until: number | undefined; ; ) {
      const page = await query({ ...listened.channels(me), limit: 1000, until });
      const fresh = page.filter((c) => !all.has(tagOf(c, "d")));
      for (const c of fresh) all.set(tagOf(c, "d"), c);
      if (page.length < 1000 || fresh.length === 0) break;
      until = Math.min(...page.map((c) => c.created_at));
    }
    made = new Map(
      [...all.values()].flatMap((c) => {
        const label = listened.label(c, me);
        return label === undefined ? [] : [[tagOf(c, "d"), { label, at: Number(tagOf(c, "created_at")) }]];
      }),
    );
    if (listened.added !== undefined)
      for (const [channel, at] of added)
        if (!made.has(channel)) made.set(channel, { label: listened.added, at });
    listen();
  };
  let [synced, due] = [Promise.resolve(), false];
  /** Has `sync` run once more after any running now; one that fails tries again in 5 s while signed in. */
  const resync = () => {
    if (due) return synced;
    due = true;
    synced = synced
      .catch(() => {})
      .then(() => {
        due = false;
        return sync();
      });
    synced.catch((e: Error) => {
      if (closed) return;
      console.error(`${what} could not read its channels: ${e.message}`);
      if (socket) setTimeout(resync, 5000);
    });
    return synced;
  };
  const open = () => {
    const ws = new WebSocket(who.relay);
    current = ws;
    let [signIn, wait, live] = ["", 5000, false];
    const send = (...frame: unknown[]) => ws.send(JSON.stringify(frame));
    const take = (type: string, a: string, b: Event & boolean, c: string) => {
      if (type === "AUTH") {
        const auth = signed(22242, Object.entries({ relay: who.relay, challenge: a }), "");
        signIn = auth.id;
        send("AUTH", auth);
      } else if (type === "OK" && a === signIn) {
        if (b !== true) {
          // buzz-relay src/handlers/auth.rs:786-790
          const outside = c.includes("not a relay member");
          wait = outside ? 60_000 : 300_000;
          if (c !== refused)
            console.error(`${what} was refused, so it tries again every ${wait / 60_000} min: ${c}`);
          refused = c;
          if (outside) notMember();
          return ws.close();
        }
        [socket, refused] = [ws, ""];
        signedIn();
        send("REQ", "notices", listened.notices(me));
        resync();
      } else if (type === "OK") waiting.get(a)?.(b === true, c);
      else if (type === "EVENT" && a === found?.id) found.events.push(b);
      else if (type === "EOSE" && a === found?.id) found.end();
      else if (type === "CLOSED" && a === found?.id)
        found.end(new Error(`the relay refused the query: ${b}`));
      else if (type === "EOSE" && a === "notices") live = true;
      else if (type === "EVENT" && a === "notices" && live) {
        if (b.kind === 44100) added.set(tagOf(b, "h"), b.created_at);
        else added.delete(tagOf(b, "h"));
        resync();
      } else if (type === "EVENT" && a === listening) held ? held.push(b) : hand(b);
      else if (type === "EOSE" && a === listening && held) {
        const backlog = held.sort((x, y) => x.created_at - y.created_at);
        held = undefined;
        for (const b of backlog) hand(b);
      } else if (type === "CLOSED" && a === listening) {
        // The relay ended the subscription, as it may when it limits a key: listen again in 5 s.
        console.error(`${what} lost its channels, so it listens again in 5 s: ${b}`);
        listening = "";
        setTimeout(() => socket === ws && resync(), 5000);
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
        ready = new Promise<void>((resolve) => (signedIn = resolve));
        listening = "";
        for (const done of waiting.values()) done(false, "the relay went");
        found?.end(new Error("the relay went"));
        if (!closed) console.error(`${what} lost the relay; it connects again in 5 s`);
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
      await soon();
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
    query,
    /** Resolves once `who` is signed in. */
    ready: () => ready,
    /** The oldest system channel `who` made labelled `label`, by the relay's record once asked, or none. */
    channel: async (label: string) => {
      await soon();
      await synced;
      return [...made].filter(([, c]) => c.label === label).sort((x, y) => x[1].at - y[1].at)[0]?.[0];
    },
    /** Asks the relay again which channels `who` made, as after a membership notice. */
    refresh: () => resync(),
    /** Ends the connection for good. */
    close: () => {
      closed = true;
      current?.close();
    },
  };
}

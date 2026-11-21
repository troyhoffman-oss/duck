import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Decoder, Encoder } from "@evan/opus";
import { callKept, told } from "./archive";
import { connect, type Event, MEMBER, sign } from "./buzz";
import { callEnded } from "./dms";
import { asked, asking, unasked } from "./outbox";
import type { Coworker } from "./run";
import { type Door, doorsOf, factsOf, ownerOf, personOf, secret } from "./setup";

/** The sound the door and the speech model trade: 16-bit mono PCM at 24 kHz, in bytes per 20 ms Opus frame. */
const [RATE, FRAME] = [24_000, 960] as const;
/** How long before the relay's own end of a call the coworker leaves it: the relay archives it then, saying nothing. */
const MARGIN = 30_000;
/** The relay's limit for a call, in seconds, where its record of the call's channel gives none. */
const LIMIT = 3600;
/** How long a hand-off waits for the transcript to pass it. */
const HEARD = 3000;
/** How long the speech model may take to begin saying what it is given, and so the quiet before a question. */
const BEGIN = 3000;
/** The longest pause between the transcript's words inside one line of the person's. */
const PAUSE = 700;
/** The longest pause between the transcript's words of one thing the speech model says. */
const BREATH = 500;
const INSTRUCTIONS = readFileSync(join(import.meta.dir, "run", "voice.md"), "utf8");

/**
 * The call each coworker is in, by its name: its voice door, and once joined, what has the coworker say words
 * and what has it ask duck's questions.
 */
const calls = new Map<string, { door: string; say?: (text: string) => void; ask?: (text: string) => void }>();
/** The call coworker `c` is in now, if any: its voice door, and what has the coworker say words and ask there. */
export const inCall = (c: Coworker) => calls.get(c.name);

type Words = { delta: string; start_ms: number; end_ms: number };
/** Whether transcript words `b` follow words `a` within one line. */
const near = (a: Words | undefined, b: Words | undefined) => !!a && !!b && b.start_ms - a.end_ms < PAUSE;
const tag = (e: Event | undefined, name: string) => e?.tags.find((t) => t[0] === name)?.[1];

/**
 * Joins, at voice door `door` of `c`, as the coworker, through its buzz door's relay and key, each call (kind
 * 48100) its own person starts in a channel whose only members are the two of them, one call at a time; it
 * leaves every other call alone. In a call the person's sound goes to the speech model `set` names, and what it
 * says comes back. At each hand-off, the line it came from, by the transcript once past the hand-off, is handed
 * to `take` as the person's message; a line with no transcript is not, and the speech model asks again. While
 * a question duck asked in the call is open, duck takes each line the person finishes from the transcript
 * itself, with when its last word was heard, and a hand-off only names what comes back (SPEC part 9). The
 * coworker leaves when the person has, when the call ends, or as the relay's limit for it nears; the questions
 * it leaves unanswered, and any a stop left, go to the person's other doors. It settles when the coworker stops.
 */
export function voiceIn(
  c: Coworker,
  door: string,
  set: Door,
  take: (id: string, text: string, at?: string) => unknown,
) {
  if (unasked(c.db, door) > 0) c.dispatch();
  const buzz = doorsOf(c.setup, c.name).buzz as Door;
  const who = {
    key: secret(c.setup, buzz.key, c.name),
    relay: buzz.address,
    owner: factsOf(c.setup, c.name).owner ?? undefined,
  };
  const owner = ownerOf(c.setup, c.name);
  /** What ends the open call, given a call's channel that ended. */
  let ended = (_backing: string) => {};
  const relay = connect(
    who,
    (e) => {
      if (e.kind === 48103) ended(e.content);
      else if (e.pubkey === owner && !calls.has(c.name)) void pickUp(e);
    },
    () => {},
    MEMBER,
  );
  const newest = async (filter: object) =>
    (await relay.query(filter)).sort((a, b) => b.created_at - a.created_at)[0];

  async function pickUp(start: Event) {
    const parent = tag(start, "h") as string;
    const backing = String(JSON.parse(start.content).ephemeral_channel_id ?? "");
    calls.set(c.name, { door });
    try {
      const members = (await newest({ kinds: [39002], "#d": [parent] }))?.tags.filter((t) => t[0] === "p");
      const keys = new Set(members?.map((t) => t[1]));
      const open = (await newest({ kinds: [39000], "#d": [parent] }))?.tags.some((t) => t[0] === "public");
      if (!backing || open || keys.size !== 2 || !keys.has(owner) || !keys.has(relay.me)) return;
      await call(parent, backing, start.created_at);
      callEnded(c.name);
    } catch (e) {
      console.error(`the call at ${c.name}.${door} broke: ${(e as Error).message}`);
    } finally {
      calls.delete(c.name);
    }
  }

  /**
   * Is in the call on channel `backing` of channel `parent`, started at `started` in seconds since 1970, until
   * it ends or the relay's end of it nears: the deadline in its record of `backing`, which it can read once a
   * member, as joining makes it.
   */
  async function call(parent: string, backing: string, started: number) {
    const speech = new WebSocket(set.address, {
      headers: { authorization: `Bearer ${secret(c.setup, set.key)}` },
    } as unknown as string[]);
    const room = new WebSocket(`${buzz.address}/huddle/${backing}/audio`);
    room.binaryType = "arraybuffer";
    const decoder = new Decoder({ channels: 1, sample_rate: RATE });
    const encoder = new Encoder({ channels: 1, sample_rate: RATE, application: "voip" });
    /** Each key in the call by its index there; the transcript not yet handed on; each hand-off waiting for it. */
    const [peers, heard, waiting] = [new Map<number, string>(), [] as Words[], new Map<string, number>()];
    let [out, seq, spoken, lastSaid, seconds] = [Buffer.alloc(0), 0, "", 0, 0];
    let [delegation, leaving, joined] = [null as string | null, false, false];
    /**
     * When the person was last heard, the speech model was last given something to say, last said anything and
     * began what it says now, by the clock; and the end of the last line duck took from the transcript itself,
     * in the session's ms.
     */
    let [lastIn, lastGiven, lastOut, spokenFrom, ownTo] = [0, 0, 0, 0, -1];
    let own: Timer | undefined;
    /**
     * duck's questions waiting to be asked, and the one being asked: when it was given, whether its words have
     * begun, and their first message.
     */
    const questions: string[] = [];
    let question: { given: number; begun: boolean; first?: number } | undefined;
    const closed = Promise.withResolvers<void>();
    const live = (event: object) =>
      speech.readyState === WebSocket.OPEN && speech.send(JSON.stringify(event));
    /** Keeps what the speech model has said since it last paused, and returns its id in the archive. */
    const keep = () => {
      const text = spoken.trim();
      spoken = "";
      if (!text) return undefined;
      const id = told(c.db, door, c.conversation() ?? null, text, []);
      if (question?.begun && question.first === undefined) question.first = id;
      return id;
    };
    const end = () => {
      if (leaving) return;
      leaving = true;
      // What the coworker says from now on goes to the person's other doors.
      calls.set(c.name, { door });
      live({ type: "session.close" });
      // A speech model that never says it has closed holds nothing up.
      setTimeout(() => speech.close(), 5000);
    };
    ended = (content) => content.includes(backing) && end();
    const leave = (at: number) => setTimeout(end, at - MARGIN - Date.now());
    let timer = leave((started + LIMIT) * 1000);

    /** Hands on the whole line hand-off `id` at `offset` came from, if the transcript has passed it. */
    const hand = (id: string, offset: number) => {
      const past = heard.findIndex((w) => w.end_ms >= offset);
      if (past < 0) return false;
      let [first, last] = [past, past];
      while (near(heard[first - 1], heard[first])) first--;
      while (near(heard[last], heard[last + 1])) last++;
      const words = heard.splice(0, last + 1).slice(first);
      waiting.delete(id);
      delegation = id;
      take(
        id,
        words
          .map((w) => w.delta)
          .join("")
          .trim(),
      );
      return true;
    };
    /** Has the speech model say `text` from the coworker, about the last line handed on. */
    const say = (text: string) => {
      lastGiven = Date.now();
      live({
        type: "session.commentary.append",
        event_id: `said-${Date.now()}`,
        delegation_id: delegation,
        content: text,
      });
    };
    /**
     * Has the speech model ask the person duck's question `text`, word for word, and then say only "One moment"
     * until it is given what happened: once nothing has been given or said for BEGIN, so that what it says next
     * is the question's. The question is asked once the last of that has played.
     */
    const ask = (text: string) => questions.push(text);
    /** Takes the line the person finished, as the transcript gives it, as their message. */
    const ownLine = () => {
      const words = heard.splice(0);
      const text = words
        .map((w) => w.delta)
        .join("")
        .trim();
      if (!text) return;
      ownTo = words.at(-1)?.end_ms ?? ownTo;
      // A hand-off of this line waits for nothing more.
      for (const [id, offset] of waiting)
        if (offset <= ownTo) {
          waiting.delete(id);
          delegation = id;
        }
      take(`line-${randomUUID()}`, text, new Date(lastIn).toISOString());
    };

    speech.onopen = () => {
      const names = {
        "{person}": personOf(c.setup, c.name).name,
        "{coworker}": factsOf(c.setup, c.name).called ?? c.name,
      };
      const instructions = Object.entries(names).reduce((t, [k, v]) => t.replaceAll(k, v), INSTRUCTIONS);
      const audio = { format: { type: "audio/pcm", rate: RATE }, output: { voice: set.voice } };
      live({
        type: "session.start",
        session: { model: set.model, instructions, delegation: { type: "client" }, audio },
      });
    };
    speech.onmessage = (m) => {
      const e = JSON.parse(String(m.data));
      if (e.usage?.seconds !== undefined) seconds = e.usage.seconds;
      if (e.type === "session.input_transcript.delta") {
        heard.push(e);
        lastIn = Date.now();
        if (asking(c.db, door)) {
          clearTimeout(own);
          own = setTimeout(ownLine, PAUSE);
        } else for (const [id, offset] of waiting) hand(id, offset);
      } else if (e.type === "session.delegation.created" && (asking(c.db, door) || e.offset_ms <= ownTo))
        delegation = e.delegation.id;
      else if (e.type === "session.delegation.created" && !hand(e.delegation.id, e.offset_ms)) {
        const id = e.delegation.id;
        waiting.set(id, e.offset_ms);
        setTimeout(() => {
          if (!waiting.delete(id)) return;
          const content = "That line was not caught: nothing goes to the coworker. Ask them to say it again.";
          live({ type: "session.commentary.append", event_id: `again-${id}`, delegation_id: id, content });
        }, HEARD);
      } else if (e.type === "session.output_transcript.delta") {
        if (e.start_ms - lastSaid >= BREATH) keep();
        if (!spoken) spokenFrom = Date.now();
        [spoken, lastSaid, lastOut] = [spoken + e.delta, e.end_ms, Date.now()];
        if (question && spokenFrom >= question.given) question.begun = true;
      } else if (e.type === "session.output_audio.delta") {
        out = Buffer.concat([out, Buffer.from(e.delta, "base64")]);
        lastOut = Date.now();
      } else if (e.type === "session.closed") speech.close();
      else if (e.type === "error")
        console.error(`the speech model at ${c.name}.${door} says: ${e.error?.message}`);
    };
    speech.onclose = () => {
      keep();
      clearTimeout(own);
      clearInterval(pace);
      clearTimeout(timer);
      if (room.readyState === WebSocket.OPEN) room.send(JSON.stringify({ type: "leave" }));
      room.close();
      console.log(JSON.stringify({ relay: c.name, kind: "voice", model: set.model, seconds }));
      closed.resolve();
    };

    room.onmessage = (m) => {
      if (typeof m.data !== "string") {
        // The relay puts the sender's index before its 8-byte header and the Opus packet.
        const frame = new Uint8Array(m.data as ArrayBuffer);
        if (peers.get(frame[0] as number) !== owner) return;
        const pcm = decoder.decode(frame.subarray(9));
        return void live({ type: "session.input_audio.append", audio: Buffer.from(pcm).toString("base64") });
      }
      const said = JSON.parse(m.data);
      if (said.type === "challenge") {
        const tags = [
          ["relay", buzz.address],
          ["challenge", said.challenge],
        ];
        const event = sign(who, Math.floor(Date.now() / 1000), 22242, tags, "");
        room.send(JSON.stringify({ type: "auth", event, parent_channel_id: parent, protocol_version: 2 }));
      } else if (said.type === "joined") {
        for (const p of [...(said.peers ?? []), said]) peers.set(p.peer_index, p.pubkey);
        if (leaving || inCall(c)?.say) return;
        callKept(c.db, door, "started");
        joined = true;
        calls.set(c.name, { door, say, ask });
        void newest({ kinds: [39000], "#d": [backing] }).then(
          (record) => {
            const deadline = Date.parse(tag(record, "ttl_deadline") ?? "");
            if (leaving || Number.isNaN(deadline)) return;
            clearTimeout(timer);
            timer = leave(deadline);
          },
          (e: Error) => console.error(`the call at ${c.name}.${door} has no deadline read: ${e.message}`),
        );
      } else if (said.type === "left") {
        peers.delete(said.peer_index);
        if (![...peers.values()].some((k) => k !== relay.me)) end();
      }
    };
    room.onclose = end;
    // The coworker's sound goes out a 20 ms frame at a time, as a phone sends it.
    const pace = setInterval(() => {
      // Quiet: all it was given has begun, or never will, and the last of what it said has played.
      const now = Date.now();
      const quiet =
        out.length === 0 && now - lastOut >= BREATH && (lastOut >= lastGiven || now - lastGiven >= BEGIN);
      if (quiet && question?.begun) {
        // The last of what was said for duck's question has played: the question is asked there.
        const kept = keep();
        const first = question.first ?? kept;
        const given = new Date(question.given).toISOString();
        if (first !== undefined) asked(c.db, door, given, first, new Date(now).toISOString());
        question = undefined;
      } else if (quiet && question) question = undefined;
      // A question is given only once nothing has been given or said for BEGIN, so that nothing given before it
      // waits to be said: what the speech model says next is the question's.
      else if (questions.length > 0 && out.length === 0 && now - Math.max(lastOut, lastGiven) >= BEGIN) {
        question = { given: now, begun: false };
        say(
          `Ask ${personOf(c.setup, c.name).name} this, word for word, then wait for their answer:\n${questions.shift()}\nWhen they answer, say only "One moment" until you are given what happened.`,
        );
      }
      if (room.readyState !== WebSocket.OPEN || out.length === 0) return;
      const pcm = new Uint8Array(FRAME);
      pcm.set(out.subarray(0, FRAME));
      out = out.subarray(FRAME);
      const packet = encoder.encode(new Int16Array(pcm.buffer));
      const frame = new Uint8Array(8 + packet.length);
      const view = new DataView(frame.buffer);
      view.setUint16(0, seq & 0xffff);
      view.setUint32(2, (seq * 960) >>> 0);
      view.setInt8(6, -20);
      frame.set(packet, 8);
      seq += 1;
      room.send(frame);
    }, 20);

    await closed.promise;
    ended = () => {};
    // A call never joined, as when the speech model refuses the session, was no call.
    if (joined) callKept(c.db, door, "ended");
    if (unasked(c.db, door) > 0) c.dispatch();
  }

  return new Promise<void>((done) =>
    c.signal.addEventListener("abort", () => {
      relay.close();
      done();
    }),
  );
}

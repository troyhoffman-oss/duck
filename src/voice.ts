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
/**
 * How long the speech model says nothing, with all it was given acknowledged, since the last of its words and
 * of those acknowledgements, before a question is given it.
 */
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
const calls = new Map<
  string,
  { door: string; say?: (text: string) => void; ask?: (ids: number[], text: string) => void }
>();
/** The call coworker `c` is in now, if any: its voice door, and what has the coworker say words and ask there. */
export const inCall = (c: Coworker) => calls.get(c.name);

type Words = { delta: string; start_ms: number; end_ms: number };
/** Whether transcript words `b` follow words `a` within one line. */
const near = (a: Words | undefined, b: Words | undefined) => !!a && !!b && b.start_ms - a.end_ms < PAUSE;
/** What transcript words `words` say. */
const textOf = (words: Words[]) =>
  words
    .map((w) => w.delta)
    .join("")
    .trim();
const tag = (e: Event | undefined, name: string) => e?.tags.find((t) => t[0] === name)?.[1];

/**
 * Joins, at voice door `door` of `c`, as the coworker, through its buzz door's relay and key, each call (kind
 * 48100) its own person starts in a channel whose only members are the two of them, one call at a time; it
 * leaves every other call alone. In a call the person's sound goes to the speech model `set` names, and what it
 * says comes back. At each hand-off, the line it came from, by the transcript once past the hand-off, is handed
 * to `take` as the person's message; a line with no transcript is not, and the speech model asks again. duck's
 * questions are asked one at a time. While one asked in the call is open, the words the person begins once it
 * has been said, by the session's own clock, form the line duck takes itself, handed to `take` to be read as
 * their answer (SPEC part 9), and a hand-off of them only names what comes back; `take` settles once that is
 * read. The coworker leaves when the person has, when the call ends, or as the relay's limit for it nears; the
 * questions it leaves unanswered, once what they last said is read, and any a stop left, go to the person's
 * other doors. It settles when the coworker stops.
 */
export function voiceIn(
  c: Coworker,
  door: string,
  set: Door,
  take: (id: string, text: string, read?: boolean) => Promise<unknown>,
) {
  if (unasked(c.db, door) > 0) c.dispatch();
  /** The reads of the lines the door took itself as the person's answer, not yet done. */
  const reading = new Set<Promise<unknown>>();
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
      const why = !backing
        ? "the start names no backing channel"
        : open
          ? "the channel is open to the community"
          : keys.size !== 2 || !keys.has(owner) || !keys.has(relay.me)
            ? `its members are not just the two of them (${keys.size} members)`
            : undefined;
      if (why)
        return console.error(`a call of ${c.name}'s person at ${c.name}.${door} is not joined: ${why}`);
      await call(parent, backing, start.created_at);
      callEnded(c.name);
    } catch (e) {
      console.error(`the call at ${c.name}.${door} broke: ${(e as Error).message}`);
    } finally {
      calls.delete(c.name);
      // Once the call is gone and what the person last said in it is read, what it left unanswered goes to their
      // other doors; if they are in a call again by then, it goes when that one ends.
      await Promise.all(reading);
      if (!calls.has(c.name) && unasked(c.db, door) > 0) c.dispatch();
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
    let [out, seq, lastSaid, seconds] = [Buffer.alloc(0), 0, 0, 0];
    let [delegation, leaving, joined] = [null as string | null, false, false];
    /** What the speech model said that the archive has not kept; the person's words after duck's question. */
    let [unkept, answer] = [[] as Words[], [] as Words[]];
    /** What the door gave the speech model to say that it has not acknowledged. */
    const unacked = new Set<string>();
    /**
     * When it last sent sound or words, or acknowledged what it was given, by the clock: the one thing timed by
     * it, to tell when it is quiet. What it acknowledged it may not have begun to say.
     */
    let lastOut = 0;
    let own: Timer | undefined;
    /**
     * duck's questions waiting their turn, and the one given it: its asks, its commentary, where that landed on
     * the session's clock (`from`), and once said, where the last of its words ended there (`to`).
     */
    const questions: { ids: number[]; text: string }[] = [];
    let question: { ids: number[]; event: string; from?: number; to?: number } | undefined;
    const closed = Promise.withResolvers<void>();
    const live = (event: object) =>
      speech.readyState === WebSocket.OPEN && speech.send(JSON.stringify(event));
    /** Keeps, as one message, what the speech model said that began before `before` on the session's clock. */
    const keep = (before = Number.POSITIVE_INFINITY) => {
      const text = textOf(unkept.filter((w) => w.start_ms < before));
      unkept = unkept.filter((w) => w.start_ms >= before);
      return text ? told(c.db, door, c.conversation() ?? null, text, []) : undefined;
    };
    /** Whether duck's question has been said and is open, and `ms` on the session's clock is after it. */
    const after = (ms: number) =>
      question?.to !== undefined && ms >= question.to && asking(c.db, question.ids);
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
      void take(id, textOf(words));
      return true;
    };
    /** Has the speech model say `text` from the coworker, about the last line handed on; returns its event's id. */
    const say = (text: string) => {
      const id = `said-${randomUUID()}`;
      unacked.add(id);
      live({ type: "session.commentary.append", event_id: id, delegation_id: delegation, content: text });
      return id;
    };
    /**
     * Has the speech model ask the person duck's question `text`, of asks `ids`, word for word, and then say only
     * "One moment" until it is given what happened: once the last question is answered and it has said nothing
     * for BEGIN with all it was given acknowledged, so that its words from where the question landed are the
     * question's. The question is asked once the last of those has gone out to the call.
     */
    const ask = (ids: number[], text: string) => questions.push({ ids, text });
    /** Takes the line the person finished after duck's question as their message, to be read as their answer. */
    const ownLine = () => {
      const text = textOf(answer.splice(0));
      if (!text) return;
      const read = take(`line-${randomUUID()}`, text, true);
      reading.add(read);
      void read.then(() => reading.delete(read));
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
      if (e.type === "session.input_transcript.delta" && after(e.start_ms)) {
        answer.push(e);
        clearTimeout(own);
        own = setTimeout(ownLine, PAUSE);
      } else if (e.type === "session.input_transcript.delta") {
        heard.push(e);
        for (const [id, offset] of waiting) hand(id, offset);
      } else if (e.type === "session.delegation.created" && after(e.offset_ms)) delegation = e.delegation.id;
      else if (e.type === "session.delegation.created" && !hand(e.delegation.id, e.offset_ms)) {
        const id = e.delegation.id;
        waiting.set(id, e.offset_ms);
        setTimeout(() => {
          if (!waiting.delete(id)) return;
          const content = "That line was not caught: nothing goes to the coworker. Ask them to say it again.";
          live({ type: "session.commentary.append", event_id: `again-${id}`, delegation_id: id, content });
        }, HEARD);
      } else if (e.type === "session.output_transcript.delta") {
        // What it says is kept a breath at a time, but a question being said is kept whole once said.
        if (e.start_ms - lastSaid >= BREATH)
          keep(question && question.to === undefined ? question.from : undefined);
        unkept.push(e);
        [lastSaid, lastOut] = [e.end_ms, Date.now()];
      } else if (e.type === "session.commentary.appended") {
        unacked.delete(e.client_event_id);
        lastOut = Date.now();
        if (question && e.client_event_id === question.event) question.from = e.end_ms;
      } else if (e.type === "session.output_audio.delta") {
        out = Buffer.concat([out, Buffer.from(e.delta, "base64")]);
        lastOut = Date.now();
      } else if (e.type === "session.closed") speech.close();
      else if (e.type === "error") {
        unacked.delete(e.error?.client_event_id);
        console.error(`the speech model at ${c.name}.${door} says: ${e.error?.message}`);
      }
    };
    speech.onclose = () => {
      keep();
      // What the person began to answer is their answer, though they hung up before a pause ended it.
      clearTimeout(own);
      ownLine();
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
        console.log(JSON.stringify({ call: c.name, door, happened: "joined" }));
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
      // How long it has been quiet: nothing said, and all it said gone out to the call.
      const quiet = out.length === 0 ? Date.now() - lastOut : 0;
      const from = question?.from;
      // Once the last of the words said from where the question landed has gone out to the call, it is asked,
      // in one message of those words, and it ended where the last of them did on the session's clock.
      if (question && from !== undefined && question.to === undefined && quiet >= BREATH) {
        keep(from);
        const to = unkept.at(-1)?.end_ms;
        const message = keep();
        if (to !== undefined && message !== undefined) {
          question.to = to;
          asked(c.db, question.ids, message);
          // Words the person began after it, heard before this, are their answer too.
          const begun = heard.findIndex((w) => w.start_ms >= to);
          if (begun >= 0) {
            answer.push(...heard.splice(begun));
            own = setTimeout(ownLine, PAUSE);
          }
        }
      }
      if (question?.to !== undefined && questions.length > 0 && !asking(c.db, question.ids))
        question = undefined;
      const next = !question && unacked.size === 0 && quiet >= BEGIN ? questions.shift() : undefined;
      if (next)
        question = {
          ids: next.ids,
          event: say(
            `Ask ${personOf(c.setup, c.name).name} this, word for word, then wait for their answer:\n${next.text}\nWhen they answer, say only "One moment" until you are given what happened.`,
          ),
        };
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
    if (joined) console.log(JSON.stringify({ call: c.name, door, happened: "left" }));
    ended = () => {};
    // A call never joined, as when the speech model refuses the session, was no call.
    if (joined) callKept(c.db, door, "ended");
  }

  return new Promise<void>((done) =>
    c.signal.addEventListener("abort", () => {
      relay.close();
      done();
    }),
  );
}

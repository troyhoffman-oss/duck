import { randomBytes, randomUUID } from "node:crypto";
import { Decoder, Encoder } from "@evan/opus";
import type { ServerWebSocket } from "bun";
import { FROM_CONTAINERS, Trouble, until } from "./reach";

type Json = Record<string, unknown>;

/** The rate of the sound the voice door and its speech model trade, 16-bit mono, and a 20 ms frame of it. */
const RATE = 24_000;
const FRAME = 480;

/**
 * The tones the stand-in speech model speaks in: its own acknowledgement, and the words it is given to say. A
 * person's line is a tone of its own, below both (see `lineTone`), so each side tells what it hears apart.
 */
export const TONES = { acknowledgement: 1200, said: 1800 } as const;
export type Heard = keyof typeof TONES | "other";

/** Each line a test has a person speak, by the order it was first spoken: its tone is 300 Hz, 20 Hz apart. */
const lines: string[] = [];
export function lineTone(text: string) {
  if (!lines.includes(text)) lines.push(text);
  const tone = 300 + 20 * lines.indexOf(text);
  if (tone >= 1000) throw new Error("the kit has a tone for 35 lines; a test speaks fewer");
  return tone;
}

/** The power of `tone` in `pcm` (Goertzel). */
function power(pcm: Int16Array, tone: number) {
  const k = 2 * Math.cos((2 * Math.PI * tone) / RATE);
  let [a, b] = [0, 0];
  for (const s of pcm) [a, b] = [s / 32768 + k * a - b, a];
  return a * a + b * b - k * a * b;
}

const loud = (pcm: Int16Array) => Math.sqrt(pcm.reduce((sum, s) => sum + s * s, 0) / (pcm.length || 1)) > 500;

/** `seconds` of `tone` at a third of full scale. */
function toneOf(tone: number, seconds: number) {
  const pcm = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i++)
    pcm[i] = Math.round(10_000 * Math.sin((2 * Math.PI * tone * i) / RATE));
  return pcm;
}

/** A person's `text` as sound: its line's tone, half a second and a twentieth of a second a word. */
export const spoken = (text: string) => toneOf(lineTone(text), 0.5 + 0.05 * text.split(/\s+/).length);

/** `pcm` as Opus packets of 20 ms each, as a phone in a Buzz call sends them. */
export function opus(pcm: Int16Array) {
  const encoder = new Encoder({ channels: 1, sample_rate: RATE, application: "voip" });
  const packets: Uint8Array[] = [];
  for (let at = 0; at < pcm.length; at += FRAME) {
    const frame = new Int16Array(FRAME);
    frame.set(pcm.subarray(at, at + FRAME));
    packets.push(encoder.encode(frame));
  }
  return packets;
}

/** Hears Opus packets as a phone does: each decoded, and called silence, one of `TONES`, or other sound. */
export function listener() {
  const decoder = new Decoder({ channels: 1, sample_rate: RATE });
  return (packet: Uint8Array): Heard | "silence" => {
    const bytes = decoder.decode(packet);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    if (!loud(pcm)) return "silence";
    const [ack, said] = [power(pcm, TONES.acknowledgement), power(pcm, TONES.said)];
    return ack > 4 * said ? "acknowledgement" : said > 4 * ack ? "said" : "other";
  };
}

/** What the stand-in does with a line it hears: hand it off, and whether its transcript ever comes. */
type Line = { hand: boolean; transcript: boolean };

/** One session the voice door opened with the stand-in, as it went. */
export type SpeechSession = {
  /** What `session.start` asked for. */
  start: Json;
  /** Each hand-off: its id, and the line the person spoke. */
  delegations: { id: string; line: string }[];
  /** What the door sent to say or to know, each with the hand-off it names, in order. */
  given: { type: "commentary" | "thinking" | "instructions"; delegation: string | null; content: string }[];
  /** Everything the stand-in said, as its transcript gave it, in order. */
  spoken: string[];
  /** The seconds its last usage event reported, once the door closed it. */
  seconds?: number;
  closed: boolean;
};

/**
 * A stand-in for a live speech model for one test, speaking the WebSocket wire format the voice door speaks: a
 * session that the door starts with the model, voice and instructions it names, sound in and out as 24 kHz
 * 16-bit mono PCM in base64, and client delegation. It takes the key the door's setup names as a bearer. A
 * line the person speaks is a tone (`lineTone`); half a second after its sound stops, the stand-in hands it
 * off and says its own acknowledgement, and gives the line's transcript in two parts, the last arriving after
 * the hand-off and ending past its offset, as a real model's can. What the door gives it to say it says after a
 * pause of 600 ms, a word every 150 ms, stopping where the person's sound cuts in, and its transcript is only
 * what it said. Its times are in ms since the session opened. It reports its seconds of use every 5 s and when
 * closed.
 */
export function startSpeech({ trouble = new Trouble() }: { trouble?: Trouble } = {}) {
  const key = randomBytes(24).toString("base64url");
  const sessions: SpeechSession[] = [];
  const told = new Map<string, Line>();
  const calls = new Map<ServerWebSocket<unknown>, ReturnType<typeof call>>();
  const server = Bun.serve({
    hostname: FROM_CONTAINERS.bind,
    port: 0,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/v1/live/sessions")
        return new Response("not found", { status: 404 });
      if (request.headers.get("authorization") !== `Bearer ${key}`)
        return Response.json(
          { error: { type: "invalid_request_error", code: "invalid_api_key" } },
          { status: 401 },
        );
      return server.upgrade(request) ? undefined : new Response(null, { status: 400 });
    },
    websocket: {
      open: (ws) => void calls.set(ws, call(ws)),
      message(ws, data) {
        calls.get(ws)?.take(JSON.parse(String(data)) as Json);
      },
      close(ws) {
        calls.get(ws)?.end();
        calls.delete(ws);
      },
    },
  });

  /** One session on socket `ws`. */
  function call(ws: ServerWebSocket<unknown>) {
    const opened = performance.now();
    const ms = () => Math.round(performance.now() - opened);
    let session: SpeechSession | undefined;
    const send = (event: Json) => ws.send(JSON.stringify({ event_id: `event_${randomUUID()}`, ...event }));
    const wrong = (message: string, client_event_id?: unknown) => {
      trouble.add(new Error(`the stand-in speech model: ${message}`));
      send({ type: "error", error: { type: "invalid_request_error", message, client_event_id } });
    };
    // The line the person is speaking now, its times in ms since the session opened, as all its times are.
    let line: { pcm: Int16Array[]; start: number; end: number; quiet?: Timer } | undefined;
    // What it is saying, and what waits its turn.
    const queue: { words: string[]; tone: number; index: number; pause: boolean }[] = [];
    let saying: Timer | undefined;
    const usage = setInterval(
      () => session && send({ type: "session.usage.updated", usage: { seconds: seconds() } }),
      5000,
    );
    const seconds = () => Math.ceil(ms() / 1000);

    /** Says `text` in `tone` once what it is saying now is said, a word every 150 ms, after a pause of 600 ms. */
    function say(text: string, tone: number) {
      const index = (session?.spoken.push("") ?? 1) - 1;
      queue.push({ words: text.split(" "), tone, index, pause: true });
      if (!saying) next();
    }
    function next() {
      while (queue[0]?.words.length === 0) queue.shift();
      const now = queue[0];
      const word = now?.words.shift();
      saying = undefined;
      if (!now || word === undefined || !session) return;
      if (now.pause) {
        now.pause = false;
        now.words.unshift(word);
        saying = setTimeout(next, 600);
        return;
      }
      const audio = toneOf(now.tone, 0.15);
      const at = { start_ms: ms(), end_ms: ms() + 150 };
      send({
        type: "session.output_audio.delta",
        delta: Buffer.from(audio.buffer).toString("base64"),
        ...at,
      });
      const delta = session.spoken[now.index] ? ` ${word}` : word;
      send({ type: "session.output_transcript.delta", delta, ...at });
      session.spoken[now.index] += delta;
      saying = setTimeout(next, 150);
    }
    /** Stops saying anything, as a person's sound cutting in makes a real model stop. */
    function hush() {
      clearTimeout(saying);
      saying = undefined;
      queue.length = 0;
    }
    function heard() {
      if (!line || !session) return;
      const { start, end } = line;
      const pcm = new Int16Array(line.pcm.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const part of line.pcm) {
        pcm.set(part, at);
        at += part.length;
      }
      line = undefined;
      const [text] = lines
        .map((l) => [l, power(pcm, lineTone(l))] as const)
        .sort((a, b) => b[1] - a[1])
        .map(([l]) => l);
      if (text === undefined) return wrong("it heard a sound that is no line a test gave the person");
      const { hand, transcript } = told.get(text) ?? { hand: true, transcript: true };
      const words = text.split(" ");
      const offset = end - 100;
      if (transcript)
        send({
          type: "session.input_transcript.delta",
          delta: words.slice(0, -1).join(" "),
          start_ms: start,
          end_ms: offset - 100,
        });
      if (hand) {
        const id = `deleg_${randomUUID()}`;
        session.delegations.push({ id, line: text });
        send({
          type: "session.delegation.created",
          offset_ms: offset,
          delegation: { id, type: "delegation", target: "client" },
        });
        say("One moment.", TONES.acknowledgement);
      }
      if (transcript)
        setTimeout(
          () =>
            send({
              type: "session.input_transcript.delta",
              delta: ` ${words.at(-1)}`,
              start_ms: offset - 100,
              end_ms: end,
            }),
          300,
        );
    }

    return {
      take(event: Json) {
        const { type, event_id } = event;
        if (!session && type !== "session.start") return wrong(`${type} came before session.start`, event_id);
        if (type === "session.start") {
          const asked = (event.session ?? {}) as Json;
          const audio = (asked.audio ?? {}) as { format?: Json; output?: Json };
          if (
            typeof asked.model !== "string" ||
            typeof asked.instructions !== "string" ||
            (asked.delegation as Json | undefined)?.type !== "client" ||
            audio.format?.type !== "audio/pcm" ||
            audio.format?.rate !== RATE
          )
            return wrong(
              "session.start names a model, instructions, client delegation and 24 kHz PCM sound",
              event_id,
            );
          session = { start: asked, delegations: [], given: [], spoken: [], closed: false };
          sessions.push(session);
          return send({ type: "session.started", session: { id: `sess_${randomUUID()}`, ...asked } });
        }
        if (type === "session.input_audio.append") {
          const bytes = Buffer.from(String(event.audio ?? ""), "base64");
          if (bytes.length % 2 !== 0) return wrong("its sound is not 16-bit", event_id);
          const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1).slice();
          const end = ms();
          const start = end - (pcm.length * 1000) / RATE;
          if (!loud(pcm)) return;
          hush();
          line ??= { pcm: [], start: Math.round(start), end: 0 };
          line.pcm.push(pcm);
          line.end = Math.round(end);
          clearTimeout(line.quiet);
          line.quiet = setTimeout(heard, 500);
          return;
        }
        if (
          type === "session.commentary.append" ||
          type === "session.thinking.append" ||
          type === "session.instructions.append"
        ) {
          const { delegation_id = null, content } = event as {
            delegation_id?: string | null;
            content?: unknown;
          };
          if (typeof content !== "string" || content === "")
            return wrong(`${type} carries no content`, event_id);
          if (delegation_id !== null && !session?.delegations.some((d) => d.id === delegation_id))
            return wrong(`${type} names a hand-off it never made`, event_id);
          const kind = String(type).split(".")[1] as SpeechSession["given"][number]["type"];
          session?.given.push({ type: kind, delegation: delegation_id, content });
          if (kind !== "commentary") return;
          send({ type: "session.commentary.appended", client_event_id: event_id });
          return say(content, TONES.said);
        }
        if (type === "session.close") {
          hush();
          clearInterval(usage);
          if (session) Object.assign(session, { seconds: seconds(), closed: true });
          send({ type: "session.closed", reason: "client_closed", usage: { seconds: seconds() } });
          return ws.close();
        }
        wrong(`it does not take ${type}`, event_id);
      },
      end() {
        hush();
        clearInterval(usage);
        clearTimeout(line?.quiet);
      },
    };
  }

  return {
    /** The coworker's voice door as duck's setup writes it, pointing at the stand-in. */
    door: {
      kind: "voice",
      address: `ws://${FROM_CONTAINERS.host}:${server.port}/v1/live/sessions`,
      model: "harbor-voice-1",
      voice: "harbor",
      key: "HARBOR_WREN_VOICE_KEY",
    },
    /** The value of the secret that door names. */
    secret: key,
    sessions,
    /** The line `text`, when the person speaks it, is handed off or not, with its transcript or without. */
    hears(text: string, line: Partial<Line>) {
      lineTone(text);
      told.set(text, { hand: true, transcript: true, ...line });
    },
    /** Waits until the door has opened `count` sessions in all, and returns the last. */
    async opened(count: number, seconds = 30) {
      await until(
        `${count} sessions with the speech model`,
        () => sessions.length >= count,
        seconds,
        trouble,
      );
      return sessions[count - 1] as SpeechSession;
    },
    trouble,
    /** Ends a step: fails on the first trouble seen, then forgets the step's sessions and lines. */
    step() {
      try {
        trouble.check();
      } finally {
        trouble.clear();
        sessions.length = 0;
        told.clear();
      }
    },
    [Symbol.asyncDispose]: () => server.stop(true),
  };
}

export type Speech = ReturnType<typeof startSpeech>;

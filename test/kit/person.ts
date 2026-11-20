import { LOCAL, type Reach, Trouble, until } from "./reach";

/** A file as it crosses an `http` door: its name, media type and bytes in base64. */
export type DoorFile = { name: string; type: string; data: string };

/** A file as a test hands it to the person's side. */
export type File = { name: string; type: string; bytes: Uint8Array | string };

/** A message the coworker delivered at one of the person's doors. */
export type Delivered = {
  door: string;
  id: string;
  text: string;
  files: { name: string; type: string; bytes: Uint8Array }[];
  at: number;
};

const toDoor = (f: File): DoorFile => ({
  name: f.name,
  type: f.type,
  data: Buffer.from(typeof f.bytes === "string" ? new TextEncoder().encode(f.bytes) : f.bytes).toString(
    "base64",
  ),
});

/**
 * The person's side of `http` doors, one per name in `doors`, each with the door's `key`. It sends what a
 * person writes to duck's door at `duck` (set with `meet`), and takes what duck delivers at each door's
 * `address`. A delivery repeated with an id it already holds is the same message. A real person cannot answer a
 * message before duck has the door's answer to delivering it, so a delivery reaches the person only once
 * `heard(id)` says duck has it.
 */
export function startPerson({
  doors,
  key,
  reach = LOCAL,
  trouble = new Trouble(),
  heard = () => true,
}: {
  doors: string[];
  key: string;
  reach?: Reach;
  trouble?: Trouble;
  heard?: (id: string) => boolean;
}) {
  const received: Delivered[] = [];
  const answered = new Set<string>();
  const refused: Delivered[] = [];
  const refusing: string[] = [];
  const taken = new Set<string>();
  let duck: { address: string; coworker: string } | null = null;
  let sent = 0;

  const server = Bun.serve({
    hostname: reach.bind,
    port: 0,
    async fetch(request) {
      const door = new URL(request.url).pathname.slice(1);
      if (request.method !== "POST" || !doors.includes(door))
        return new Response("not found", { status: 404 });
      if (request.headers.get("authorization") !== `Bearer ${key}`)
        return new Response("wrong key", { status: 401 });
      const body = (await request.json()) as { id?: unknown; text?: unknown; files?: DoorFile[] };
      if (typeof body.id !== "string" || typeof body.text !== "string")
        return new Response("a delivery needs an id and a text", { status: 400 });
      const message: Delivered = {
        door,
        id: body.id,
        text: body.text,
        files: (body.files ?? []).map((f) => ({
          name: f.name,
          type: f.type,
          bytes: new Uint8Array(Buffer.from(f.data, "base64")),
        })),
        at: performance.now(),
      };
      if (refusing.some((t) => message.text.includes(t))) {
        refused.push(message);
        return new Response("this door refuses it", { status: 500 });
      }
      if (!received.some((m) => m.id === message.id)) received.push(message);
      return new Response(null, { status: 204 });
    },
  });

  const reached = (m: Delivered) => {
    if (!answered.has(m.id) && heard(m.id)) answered.add(m.id);
    return answered.has(m.id);
  };
  const unread = () => received.filter((m) => !taken.has(m.id) && reached(m));

  return {
    /** Where duck delivers at door `door`. */
    address: (door: string) => `http://${reach.host}:${server.port}/${door}`,
    received,
    /** Each try of a delivery a door refused. */
    refused,
    /** Makes every door refuse, with a 500, each delivery whose text holds `text`. */
    refuse: (text: string) => refusing.push(text),
    /** Sets the duck this person writes to, and the coworker whose doors these are. */
    meet(address: string, coworker: string) {
      duck = { address, coworker };
    },
    /** Writes `text`, with `files`, at door `door`, saying it was written `at` where given. Returns duck's answer. */
    async send(door: string, text: string, files: File[] = [], at?: string) {
      if (!duck) throw new Error("the person has no duck to write to yet");
      const response = await fetch(`${duck.address}/doors/${duck.coworker}/${door}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ id: `person-${++sent}`, text, files: files.map(toDoor), at }),
      });
      if (response.status !== 202)
        throw new Error(`duck answered the person's message at ${door} with ${response.status}`);
      return response;
    },
    /**
     * The next message not yet taken, at any door or at `door`, waiting up to `seconds` for it. It is
     * taken, so the next call returns the one after it.
     */
    async next(seconds: number, door?: string): Promise<Delivered> {
      const first = () => unread().find((m) => door === undefined || m.door === door);
      await until(
        `the next message${door ? ` at ${door}` : ""}`,
        () => first() !== undefined,
        seconds,
        trouble,
      );
      const message = first() as Delivered;
      taken.add(message.id);
      return message;
    },
    /**
     * The first message not yet taken that holds `text`, waiting up to `seconds` for it. It and every
     * message before it are taken.
     */
    async nextWith(text: string, seconds: number): Promise<Delivered> {
      const first = () => unread().find((m) => m.text.includes(text));
      await until(`a message with "${text}"`, () => first() !== undefined, seconds, trouble);
      const message = first() as Delivered;
      for (const m of received.slice(0, received.indexOf(message) + 1)) taken.add(m.id);
      return message;
    },
    /** Fails if any message arrives within `seconds`, naming it. */
    async quiet(seconds: number) {
      const end = Date.now() + seconds * 1000;
      while (Date.now() < end) {
        trouble.check();
        const [first] = unread();
        if (first)
          throw new Error(`expected no message for ${seconds} s, got at ${first.door}: "${first.text}"`);
        await Bun.sleep(20);
      }
    },
    /** Fails naming the first message delivered and never taken. */
    check() {
      const [first] = unread();
      if (first) throw new Error(`a message at ${first.door} was never read: "${first.text}"`);
    },
    /** Takes every message delivered and forgets what the doors refused and were told to refuse, for the next step. */
    clear() {
      for (const m of received) taken.add(m.id);
      refused.length = 0;
      refusing.length = 0;
    },
    stop: () => server.stop(true),
  };
}

export type Person = ReturnType<typeof startPerson>;

import { randomBytes, randomUUID } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import type { ServerWebSocket } from "bun";
import { FROM_CONTAINERS, freePort, until } from "./reach";

/** The person's own address, a stranger's, and the coworker's own mailbox at the mail service. */
export const ROSA = "rosa@harbor.example";
const SAM = "sam@harbor.example";
const MAILBOX = "wren@mail.harbor.example";

/** The sender checks a mail fared in, as the mail service reports them. */
type Checks = { spf?: string; dkim?: string; dmarc?: string };

/**
 * A mail the coworker's mailbox sent: its id and thread, to whom, its subject where it gave one, its words, its
 * files, the mail it replies to, if any, and when the stand-in had it.
 */
export type Sent = {
  id: string;
  thread: string;
  to: string[];
  subject?: string;
  text: string;
  /** The same words as HTML, where it sent them so. */
  html?: string;
  files: { name: string; bytes: Buffer }[];
  replyTo?: string;
  at: number;
};

/**
 * A stand-in for AgentMail for one test, speaking only what duck's email door calls: the stream at /v0, which
 * takes a subscribe with the key as a bearer and sends each mail received as an event, the messages of the
 * coworker's mailbox, listed after a time a few at a time as the service may, got one by one, and their files;
 * and a reply or a new mail, sent once for each idempotency key. The person and a stranger mail the coworker's
 * mailbox. It answers a ping on the stream with a pong, until it is hushed.
 */
export function startEmail() {
  const key = randomBytes(24).toString("base64url");
  const received = new Map<string, Record<string, unknown>>();
  const stored = new Map<string, { name: string; type: string; bytes: Buffer }>();
  const once = new Map<string, Sent>();
  const sent: Sent[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let opened = 0;
  let pages = 0;
  const base = `/v0/inboxes/${encodeURIComponent(MAILBOX)}/messages`;
  const missing = () => Response.json({ name: "NotFoundError", message: "not found" }, { status: 404 });

  const port = freePort();
  const server = Bun.serve({
    hostname: FROM_CONTAINERS.bind,
    port,
    async fetch(request, at) {
      const url = new URL(request.url);
      const file = url.pathname.startsWith("/files/") && stored.get(url.pathname.slice("/files/".length));
      if (file) return new Response(file.bytes);
      if (request.headers.get("authorization") !== `Bearer ${key}`)
        return Response.json({ name: "UnauthorizedError", message: "unauthorized" }, { status: 401 });
      if (url.pathname === "/v0")
        return at.upgrade(request) ? undefined : new Response(null, { status: 400 });
      if (!url.pathname.startsWith(base)) return missing();
      const [, id = "", part, attachment] = url.pathname
        .slice(base.length)
        .split("/")
        .map(decodeURIComponent);
      if (request.method === "POST" && (id === "send" || part === "reply")) {
        const ref = request.headers.get("idempotency-key") ?? randomUUID();
        const body = (await request.json()) as {
          to: string[];
          subject?: string;
          text: string;
          html?: string;
          attachments?: { filename: string; content: string }[];
        };
        const on = received.get(id);
        if (part === "reply" && !on) return missing();
        const mail = once.get(ref) ?? {
          id: `<${randomUUID()}@mail.harbor.example>`,
          thread: on ? String(on.thread_id) : randomUUID(),
          to: body.to,
          subject: body.subject,
          text: body.text,
          html: body.html,
          files: (body.attachments ?? []).map((a) => ({
            name: a.filename,
            bytes: Buffer.from(a.content, "base64"),
          })),
          replyTo: on ? id : undefined,
          at: performance.now(),
        };
        if (!once.has(ref)) sent.push(mail);
        once.set(ref, mail);
        return Response.json({ message_id: mail.id, thread_id: mail.thread });
      }
      if (request.method !== "GET") return missing();
      if (!id) {
        // A page holds at most four mails whatever the limit asked, as the service's may hold fewer.
        const after = Date.parse(url.searchParams.get("after") ?? "") || 0;
        const at = Number(url.searchParams.get("page_token") ?? 0);
        const size = Math.min(Number(url.searchParams.get("limit") ?? 100), 4);
        const all = [...received.values()].filter((m) => Date.parse(String(m.timestamp)) > after);
        if (url.searchParams.get("ascending") !== "true") all.reverse();
        const messages = all.slice(at, at + size);
        if (at > 0) pages += 1;
        const next_page_token = at + size < all.length ? String(at + size) : undefined;
        return Response.json({ count: messages.length, limit: size, messages, next_page_token });
      }
      const mail = received.get(id);
      if (!mail) return missing();
      if (part !== "attachments") return Response.json(mail);
      const kept = stored.get(attachment ?? "");
      if (!kept) return missing();
      const download_url = `http://${FROM_CONTAINERS.host}:${port}/files/${attachment}`;
      return Response.json({
        attachment_id: attachment,
        filename: kept.name,
        size: kept.bytes.length,
        download_url,
      });
    },
    websocket: {
      open() {
        opened += 1;
      },
      message(ws, data) {
        const asked = JSON.parse(String(data)) as { type?: string; inbox_ids?: string[] };
        if (asked.type !== "subscribe" || !asked.inbox_ids?.includes(MAILBOX))
          return void ws.send(
            JSON.stringify({ type: "error", name: "ValidationError", message: "no such inbox" }),
          );
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "subscribed", inbox_ids: [MAILBOX], organization_id: "harbor" }));
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  // The stream reaches the stand-in through a relay that passes its bytes both ways until it is hushed, when it
  // stops passing them and closes nothing, as a connection that died without closing does. Other calls pass.
  const hushed = new Set<Socket>();
  const streams = new Set<[Socket, Socket]>();
  const relay = createServer((near) => {
    const far = connect(port, "127.0.0.1");
    const pair: [Socket, Socket] = [near, far];
    near.once("data", (first) => {
      far.write(first);
      if (first.toString("latin1").startsWith("GET /v0 ")) streams.add(pair);
      near.pipe(far);
      far.pipe(near);
    });
    for (const [a, b] of [pair, [far, near]] as [Socket, Socket][]) {
      a.on("error", () => b.destroy());
      a.on("close", () => {
        b.destroy();
        streams.delete(pair);
      });
    }
  });
  const front = freePort();
  relay.listen(front, FROM_CONTAINERS.bind);

  /**
   * `from`, as `name`, mails the coworker's mailbox `words` under `subject`, with `files`, faring as `checks`
   * says in the sender checks; `on`, a mail the coworker sent, puts it on that mail's thread, quoting it below
   * the new words as a mail client does. A file marked inline is a picture the mail's body shows, as one in a
   * signature is. Returns the mail's id and thread.
   */
  function wrote(
    from: string,
    name: string,
    subject: string,
    words: string,
    given: { files?: { name: string; bytes: string; inline?: boolean }[]; checks?: Checks; on?: Sent } = {},
  ) {
    const checks = given.checks ?? { spf: "pass", dkim: "pass", dmarc: "pass" };
    const passed = Object.values(checks).includes("pass");
    const attachments = (given.files ?? []).map((f) => {
      const attachment_id = randomUUID();
      stored.set(attachment_id, { name: f.name, type: "text/plain", bytes: Buffer.from(f.bytes) });
      const meta = { filename: f.name, size: f.bytes.length, content_type: "text/plain" };
      const shown = f.inline && {
        content_disposition: "inline",
        content_id: `<${attachment_id}@harbor.example>`,
      };
      return { attachment_id, ...meta, ...(shown || { content_disposition: "attachment" }) };
    });
    const quoted = given.on
      ? `\n\nOn ${new Date().toUTCString()}, ${MAILBOX} wrote:\n> ${given.on.text}`
      : "";
    const message = {
      inbox_id: MAILBOX,
      message_id: `<${randomUUID()}@harbor.example>`,
      thread_id: given.on?.thread ?? randomUUID(),
      labels: ["received", "unread", ...(passed ? [] : ["unauthenticated"])],
      timestamp: new Date().toISOString(),
      from: `${name} <${from}>`,
      to: [MAILBOX],
      subject,
      text: `${words}${quoted}`,
      extracted_text: words,
      attachments,
      authentication_results: checks,
      in_reply_to: given.on?.id,
    };
    received.set(message.message_id, message);
    const event_type = passed ? "message.received" : "message.received.unauthenticated";
    const event = {
      type: "event",
      event_type,
      event_id: randomUUID(),
      message,
      thread: { thread_id: message.thread_id },
    };
    for (const ws of sockets) ws.send(JSON.stringify(event));
    return { id: message.message_id, thread: message.thread_id };
  }

  const taken = new Set<Sent>();
  return {
    /** The coworker's email door as duck's setup writes it, pointing at the stand-in. */
    door: {
      kind: "email",
      address: `http://${FROM_CONTAINERS.host}:${front}`,
      mailbox: MAILBOX,
      key: "HARBOR_WREN_MAIL_KEY",
      auth: "HARBOR_ROSA_MAIL",
    },
    /** The secrets that door names: the mailbox's key and the person's own address. */
    secrets: { HARBOR_WREN_MAIL_KEY: key, HARBOR_ROSA_MAIL: ROSA },
    /** Waits until the coworker's mailbox has its stream open. */
    online: (seconds = 60) => until("the email door's stream open", () => sockets.size > 0, seconds),
    /** How many streams have been opened. */
    opened: () => opened,
    /** How many pages after the first a listing of the mailbox's mail asked for. */
    pages: () => pages,
    /** Hushes every stream open now: none of its bytes pass either way any more, and nothing closes it. */
    hush() {
      for (const pair of streams) {
        for (const s of pair) {
          s.unpipe();
          s.pause();
          hushed.add(s);
        }
        streams.delete(pair);
      }
    },
    person: {
      send: (subject: string, words: string, given?: Parameters<typeof wrote>[4]) =>
        wrote(ROSA, "Rosa Alvarez", subject, words, given),
      /** The coworker's next mail to the person not yet taken, waiting up to `seconds` for it. */
      async next(seconds: number): Promise<Sent> {
        const mine = () => sent.find((m) => m.to.includes(ROSA) && !taken.has(m));
        await until("the coworker's next mail", () => mine() !== undefined, seconds);
        const found = mine() as Sent;
        taken.add(found);
        return found;
      },
    },
    stranger: {
      send: (subject: string, words: string, given?: Parameters<typeof wrote>[4]) =>
        wrote(SAM, "Sam Okafor", subject, words, given),
    },
    /** Fails if the coworker's mailbox sends anything in the next `seconds`. */
    async quiet(seconds: number) {
      const before = sent.length;
      await Bun.sleep(seconds * 1000);
      if (sent.length > before) throw new Error(`the coworker mailed "${sent[before]?.text}"`);
    },
    /** Every mail the coworker's mailbox sent, to anyone. */
    sent,
    [Symbol.asyncDispose]: async () => {
      for (const s of hushed) s.destroy();
      relay.close();
      await server.stop(true);
    },
  };
}

export type EmailService = ReturnType<typeof startEmail>;

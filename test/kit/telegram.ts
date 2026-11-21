import { randomBytes, randomInt } from "node:crypto";
import { extname } from "node:path";
import { FROM_CONTAINERS, freePort, until } from "./reach";

/** A styled range of a message's words, as the Bot API's MessageEntity gives it, with a link's url. */
export type Entity = { type: string; offset: number; length: number; url?: string };
/**
 * A message the coworker's bot sent: the chat it went to, its words or its document's caption, their styles,
 * its document, and when the stand-in had it.
 */
export type BotMessage = {
  chat: number;
  text: string;
  entities: Entity[];
  files: { name: string; bytes: Buffer }[];
  at: number;
};

/** The person's and a stranger's Telegram user ids, past 32 bits as the Bot API says ids may be, and a group's chat. */
const ROSA = 5_000_000_000 + randomInt(1_000_000);
const SAM = 6_000_000_000 + randomInt(1_000_000);
const GROUP = -1_000_000_000_000 - randomInt(1_000_000);

/** The tags the Bot API's HTML parse mode takes, as the entity each makes (core.telegram.org/bots/api#html-style). */
const TAGS: Record<string, string> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline",
  ins: "underline",
  s: "strikethrough",
  strike: "strikethrough",
  del: "strikethrough",
  "tg-spoiler": "spoiler",
  a: "text_link",
  code: "code",
  pre: "pre",
  blockquote: "blockquote",
};
/** The only named HTML entities the Bot API takes. */
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"' };
const unescaped = (s: string) => s.replace(/&(lt|gt|amp|quot);/g, (_, n: string) => NAMED[n] as string);

/**
 * `html` as the Bot API's HTML parse mode reads it: its words and their entities, or why it is refused. Only
 * the listed tags, the four named entities and numerical ones are taken, and a bare <, > or & is refused.
 */
function parsed(html: string): { text: string; entities: Entity[] } | string {
  let text = "";
  const open: { tag: string; entity: Entity }[] = [];
  const entities: Entity[] = [];
  for (const [token, close, tag, attrs = "", entity] of html.matchAll(
    /<(\/?)([a-z-]+)([^<>]*)>|&(#\d+|#x[0-9a-f]+|[a-z]+);|[<>&]|[^<>&]+/gi,
  )) {
    if (tag !== undefined) {
      const name = tag.toLowerCase();
      if (!close) {
        const type = TAGS[name];
        if (!type) return `can't parse entities: Unsupported start tag "${name}"`;
        const href = /href="([^"]*)"/.exec(attrs)?.[1];
        open.push({
          tag: name,
          entity: { type, offset: text.length, length: 0, ...(href && { url: unescaped(href) }) },
        });
        continue;
      }
      const last = open.pop();
      if (last?.tag !== name) return `can't parse entities: Can't find start tag for end tag "${name}"`;
      last.entity.length = text.length - last.entity.offset;
      if (last.entity.length > 0) entities.push(last.entity);
    } else if (entity !== undefined) {
      const code = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      const char = entity.startsWith("#") ? String.fromCodePoint(code) : NAMED[entity];
      if (char === undefined) return `can't parse entities: Unsupported HTML entity "&${entity};"`;
      text += char;
    } else if (/^[<>&]$/.test(token)) return `can't parse entities: Unescaped "${token}"`;
    else text += token;
  }
  if (open.length > 0) return `can't parse entities: Can't find end tag for "${open[0]?.tag}"`;
  return { text, entities };
}

/**
 * A stand-in for Telegram's Bot API for one test, at `/bot<token>/<method>` and its files at
 * `/file/bot<token>/<file_path>`, answering the calls a door makes as core.telegram.org/bots/api says:
 * getUpdates by long polling, each update kept until a call's offset passes it, and a newer call ending one
 * still open with a 409; getFile and the file it names; sendMessage and sendDocument, their words in no parse
 * mode or HTML's, refused past 4096 characters, or a caption past 1024, once parsed; sendChatAction; getMe
 * and deleteWebhook. Parameters come as a query string, JSON, a form or multipart. The person writes to the
 * bot in her private chat with it or in a group it is in, and a stranger in theirs.
 */
export function startTelegram() {
  const token = `${randomInt(1_000_000_000)}:${randomBytes(26).toString("base64url")}`;
  const updates: { update_id: number; message: Record<string, unknown> }[] = [];
  const stored = new Map<string, { path: string; bytes: Buffer }>();
  const sent: BotMessage[] = [];
  /** Every chat action the bot sent, such as typing, and when. */
  const actions: { action: string; chat: number; at: number }[] = [];
  /** The chats the bot may write in: those that wrote to it. */
  const chats = new Set<number>();
  let [nextUpdate, nextMessage, nextFile, polls] = [randomInt(1_000_000), 1, 1, 0];
  /** The getUpdates call held open now, if one is: what ends it with what is due, or with a 409. */
  let waiting: { give: () => void; conflict: () => void } | undefined;

  const answer = (result: unknown) => Response.json({ ok: true, result });
  const refuse = (error_code: number, description: string) =>
    Response.json({ ok: false, error_code, description }, { status: error_code });

  /** Keeps `bytes` as a file under `folder`, as getFile's file_path names it, and returns its file_id. */
  const keep = (bytes: Buffer, folder: string, extension: string) => {
    const file_id = randomBytes(12).toString("base64url");
    stored.set(file_id, { path: `${folder}/file_${nextFile++}${extension}`, bytes });
    return { file_id, file_unique_id: file_id, file_size: bytes.length };
  };

  async function params(request: Request) {
    const got: Record<string, unknown> = Object.fromEntries(new URL(request.url).searchParams);
    const type = request.headers.get("content-type") ?? "";
    if (type.startsWith("application/json")) Object.assign(got, await request.json());
    else if (/^(multipart\/form-data|application\/x-www-form-urlencoded)/.test(type))
      for (const [k, v] of (await request.formData()).entries()) got[k] = v;
    return got;
  }

  /** A send's words in `field` as its parse mode reads them, or why the Bot API refuses them. */
  function words(p: Record<string, unknown>, field: string, most: number) {
    const raw = String(p[field] ?? "");
    if (p.parse_mode !== undefined && p.parse_mode !== "HTML")
      return "Bad Request: the stand-in reads the HTML parse mode only";
    const got = p.parse_mode === "HTML" ? parsed(raw) : { text: raw, entities: [] };
    if (typeof got === "string") return `Bad Request: ${got}`;
    if (got.text.length > most)
      return `Bad Request: message ${field === "text" ? "" : "caption "}is too long`;
    return got;
  }

  async function call(method: string, p: Record<string, unknown>, request: Request) {
    const chat = Number(p.chat_id);
    if (method.startsWith("send") && !chats.has(chat)) return refuse(400, "Bad Request: chat not found");
    const date = Math.floor(Date.now() / 1000);
    switch (method) {
      case "getme":
        return answer({ id: Number(token.split(":")[0]), is_bot: true, first_name: "Wren" });
      case "deletewebhook":
        return answer(true);
      case "getupdates": {
        polls += 1;
        if (p.offset !== undefined)
          updates.splice(0, updates.filter((u) => u.update_id < Number(p.offset)).length);
        const due = () => updates.slice(0, Number(p.limit ?? 100));
        if (due().length > 0 || !Number(p.timeout)) return answer(due());
        waiting?.conflict();
        const ended = Promise.withResolvers<Response>();
        const mine = {
          give: () => ended.resolve(answer(due())),
          conflict: () => ended.resolve(refuse(409, "Conflict: terminated by other getUpdates request")),
        };
        waiting = mine;
        const timer = setTimeout(mine.give, Number(p.timeout) * 1000);
        request.signal.addEventListener("abort", mine.give);
        const response = await ended.promise;
        clearTimeout(timer);
        if (waiting === mine) waiting = undefined;
        return response;
      }
      case "getfile": {
        const file = stored.get(String(p.file_id));
        if (!file) return refuse(400, "Bad Request: invalid file_id");
        return answer({ file_id: p.file_id, file_size: file.bytes.length, file_path: file.path });
      }
      case "sendchataction":
        actions.push({ action: String(p.action), chat, at: performance.now() });
        return answer(true);
      case "sendmessage": {
        const got = words(p, "text", 4096);
        if (typeof got === "string") return refuse(400, got);
        if (got.text.trim() === "") return refuse(400, "Bad Request: message text is empty");
        sent.push({ chat, ...got, files: [], at: performance.now() });
        return answer({
          message_id: nextMessage++,
          chat: { id: chat, type: "private" },
          date,
          text: got.text,
        });
      }
      case "senddocument": {
        if (!(p.document instanceof File))
          return refuse(400, "Bad Request: the stand-in takes an uploaded file");
        const got = words(p, "caption", 1024);
        if (typeof got === "string") return refuse(400, got);
        const files = [{ name: p.document.name, bytes: Buffer.from(await p.document.arrayBuffer()) }];
        sent.push({ chat, ...got, files, at: performance.now() });
        return answer({ message_id: nextMessage++, chat: { id: chat, type: "private" }, date });
      }
      default:
        return refuse(404, "Not Found");
    }
  }

  const server = Bun.serve({
    hostname: FROM_CONTAINERS.bind,
    port: freePort(),
    // A getUpdates call is held open for as long as its timeout.
    idleTimeout: 0,
    async fetch(request) {
      const path = decodeURIComponent(new URL(request.url).pathname);
      const files = `/file/bot${token}/`;
      if (path.startsWith(files)) {
        const file = [...stored.values()].find((f) => f.path === path.slice(files.length));
        return file ? new Response(file.bytes) : refuse(404, "Not Found");
      }
      const [, bot, method = ""] = /^\/bot([^/]*)\/([^/]+)$/.exec(path) ?? [];
      if (bot !== token) return refuse(401, "Unauthorized");
      return call(method.toLowerCase(), await params(request), request);
    },
  });

  /**
   * User `from` writes `words` in `chat`, with a document or a photo, whose caption the words then are. A photo
   * is given as its sizes' bytes, smallest first, as the Bot API lists them. Returns when.
   */
  function wrote(
    from: { id: number; first_name: string },
    chat: { id: number; type: string },
    words: string,
    given: { document?: { name: string; bytes: string; type?: string }; photo?: string[] } = {},
  ) {
    chats.add(chat.id);
    const { document, photo } = given;
    const message: Record<string, unknown> = {
      message_id: nextMessage++,
      from: { ...from, is_bot: false },
      chat,
      date: Math.floor(Date.now() / 1000),
      ...(document || photo ? { caption: words } : { text: words }),
    };
    if (document)
      message.document = {
        ...keep(Buffer.from(document.bytes), "documents", extname(document.name)),
        file_name: document.name,
        mime_type: document.type ?? "text/plain",
      };
    if (photo)
      message.photo = photo.map((bytes, i) => ({
        ...keep(Buffer.from(bytes), "photos", ".jpg"),
        width: 90 * 4 ** i,
        height: 90 * 4 ** i,
      }));
    updates.push({ update_id: nextUpdate++, message });
    waiting?.give();
    return performance.now();
  }

  const rosa = { id: ROSA, first_name: "Rosa" };
  const taken = new Set<BotMessage>();
  const unread = () => sent.filter((m) => m.chat === ROSA && !taken.has(m));
  return {
    /** The coworker's Telegram door as duck's setup writes it, pointing at the stand-in. */
    door: {
      kind: "telegram",
      address: `http://${FROM_CONTAINERS.host}:${server.port}`,
      key: "HARBOR_TELEGRAM_TOKEN",
      auth: "HARBOR_ROSA_TELEGRAM",
    },
    /** The secrets that door names: the bot's token and the person's own Telegram user id. */
    secrets: { HARBOR_TELEGRAM_TOKEN: token, HARBOR_ROSA_TELEGRAM: String(ROSA) },
    /** The person's Telegram user id, which is also the id of her private chat with the bot. */
    rosa: ROSA,
    /** Waits until the coworker's bot holds a getUpdates call open. */
    online: (seconds = 60) => until("the Telegram door polling", () => waiting !== undefined, seconds),
    /** How many getUpdates calls the bot has made. */
    polls: () => polls,
    person: {
      /** She writes `words` to the bot in her private chat with it, with a document or a photo if given. */
      send: (words: string, given?: Parameters<typeof wrote>[3]) =>
        wrote(rosa, { id: ROSA, type: "private" }, words, given),
      /** She writes `words` in a group the bot is in. */
      inGroup: (words: string) => wrote(rosa, { id: GROUP, type: "group" }, words),
      /** The bot's next message to her not yet taken, waiting up to `seconds` for it. */
      async next(seconds: number): Promise<BotMessage> {
        await until("the coworker's next Telegram message", () => unread().length > 0, seconds);
        const found = unread()[0] as BotMessage;
        taken.add(found);
        return found;
      },
      /** The bot's next message to her that holds `text`, taking every one before it. */
      async nextWith(text: string, seconds: number): Promise<BotMessage> {
        const first = () => unread().find((m) => m.text.includes(text));
        await until(`a Telegram message with "${text}"`, () => first() !== undefined, seconds);
        const found = first() as BotMessage;
        for (const m of sent.slice(0, sent.indexOf(found) + 1)) taken.add(m);
        return found;
      },
    },
    stranger: {
      send: (words: string) => wrote({ id: SAM, first_name: "Sam" }, { id: SAM, type: "private" }, words),
    },
    /** Fails if the bot sends anything in the next `seconds`. */
    async quiet(seconds: number) {
      const before = sent.length;
      await Bun.sleep(seconds * 1000);
      if (sent.length > before) throw new Error(`the coworker's bot sent "${sent[before]?.text}"`);
    },
    /** Every message the bot sent, to anyone. */
    sent,
    actions,
    [Symbol.asyncDispose]: async () => {
      waiting?.give();
      await server.stop(true);
    },
  };
}

export type Telegram = ReturnType<typeof startTelegram>;

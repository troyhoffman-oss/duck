import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { chatText, keep, taken } from "./doors";
import type { Coworker } from "./run";
import { type Door, secret } from "./setup";

/** How long a getUpdates call waits for an update, in seconds. One that has not answered 10 s past it is given up. */
const POLL = 50;
/** How often typing is sent again: Telegram shows it for 5 s or less (core.telegram.org/bots/api#sendchataction). */
const TYPING = 4000;
/** The longest message the Bot API sends, in characters once its HTML is parsed (core.telegram.org/bots/api#sendmessage). */
const LONGEST = 4096;

/** A message as the Bot API gives it, in the fields the door reads (core.telegram.org/bots/api#message). */
type Message = {
  message_id: number;
  from?: { id: number };
  chat: { id: number; type: string };
  date: number;
  text?: string;
  caption?: string;
  [field: string]: unknown;
};
/**
 * A file a message carries: its document, voice note, audio, video, sticker or the like, each an object with a
 * `file_id`, or its photo, a list of sizes smallest first (core.telegram.org/bots/api#message).
 */
type Carried = { file_id: string; file_name?: string; mime_type?: string };

/** The Bot API's answer refusing a call, as against its not being reached. */
class Refused extends Error {}

/** Each Telegram door's typing, sent again after a message goes out there, since one clears it. */
const typists = new Map<Door, () => void>();

/**
 * Calls Bot API method `method` of Telegram door `set`'s bot with `params`, as JSON or as a multipart form,
 * and returns its result, or throws with the method and what the Bot API said. The token is in the call's
 * address, so no error carries the address.
 */
async function bot<T>(c: Coworker, set: Door, method: string, params: object, signal?: AbortSignal) {
  const body = params instanceof FormData ? params : JSON.stringify(params);
  const headers = params instanceof FormData ? undefined : { "content-type": "application/json" };
  const answer = await fetch(`${set.address}/bot${secret(c.setup, set.key)}/${method}`, {
    method: "POST",
    headers,
    body,
    signal,
  }).catch((error: Error) => {
    throw new Error(`the Bot API's ${method} was not reached (${error.name})`);
  });
  const got = (await answer.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!got.ok) throw new Refused(`the Bot API answered ${method} with ${answer.status}: ${got.description}`);
  return got.result as T;
}

/**
 * Hands each message its person writes to Telegram door `set`'s bot in their private chat to `door`, with the
 * file it carries, a photo at its largest size. Where the Bot API refuses to hand the file over, as it does one
 * past 20 MB, the message is taken without it, its words saying so and why. A message from anyone else, or in a group, is dropped, and each
 * such sender and chat logged once. The bot's updates are taken by long polling, each call confirming those
 * before it once they are taken, and the poll is kept going; after a stop, Telegram gives again what was not
 * confirmed, and the inbox takes each message once. Typing shows in the chat, best effort, while a message
 * from this door waits or its run goes on, as it does for a run a restart cut.
 */
export async function telegramIn(c: Coworker, door: string, set: Door) {
  const person = secret(c.setup, set.auth as string);
  const what = `the Telegram door ${c.name}.${door}`;
  const strangers = new Set<string>();
  const open = c.db.query("select 1 from inbox where source = ? and state != 'done' limit 1");
  let every: Timer | undefined;
  const typing = () => {
    if (!open.get(door) || c.signal.aborted) {
      clearInterval(every);
      every = undefined;
      return;
    }
    bot(c, set, "sendChatAction", { chat_id: person, action: "typing" }).catch((error: Error) =>
      console.error(`${what} could not show typing: ${error.message}`),
    );
    every ??= setInterval(typing, TYPING);
  };
  typists.set(set, typing);
  c.signal.addEventListener("abort", () => clearInterval(every));
  typing();
  /** File `f` as the door hands it on, or the words that say the Bot API would not hand it over, and why. */
  const file = async (f: Carried) => {
    try {
      const { file_path } = await bot<{ file_path: string }>(c, set, "getFile", { file_id: f.file_id });
      const got = await fetch(`${set.address}/file/bot${secret(c.setup, set.key)}/${file_path}`).catch(
        (error: Error) => {
          throw new Error(`the Bot API's file download was not reached (${error.name})`);
        },
      );
      if (!got.ok) throw new Refused(`the Bot API answered its download with ${got.status}`);
      const data = Buffer.from(await got.arrayBuffer()).toString("base64");
      return { name: f.file_name ?? basename(file_path), type: f.mime_type ?? "", data };
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      const name = f.file_name ? `${f.file_name} ` : "";
      return `Telegram would not hand over the file ${name}that came with this message: ${error.message}.`;
    }
  };
  let offset: number | undefined;
  await keep(c, door, `${what}'s poll`, async () => {
    for (;;) {
      const signal = AbortSignal.any([c.signal, AbortSignal.timeout((POLL + 10) * 1000)]);
      const asked = { offset, timeout: POLL, allowed_updates: ["message"] };
      const updates = await bot<{ update_id: number; message?: Message }[]>(
        c,
        set,
        "getUpdates",
        asked,
        signal,
      );
      for (const u of updates) {
        const m = u.message;
        if (m && String(m.from?.id) === person && m.chat.type === "private") {
          const carried = (Object.values(m) as (Carried | Carried[] | undefined)[])
            .map((v) => (Array.isArray(v) ? v.at(-1) : v))
            .find((v) => v?.file_id);
          const got = carried ? await file(carried) : null;
          const words = m.text ?? m.caption ?? "";
          const text = typeof got === "string" ? [words, got].filter(Boolean).join("\n\n") : words;
          const files = got && typeof got !== "string" ? [got] : [];
          const at = new Date(m.date * 1000).toISOString();
          if (await taken(c, door, { id: String(m.message_id), text, files, at })) typing();
        } else if (m && !strangers.has(`${m.from?.id}/${m.chat.id}`)) {
          strangers.add(`${m.from?.id}/${m.chat.id}`);
          console.error(`${what} dropped a message not its person's, or not in their private chat`);
        }
        offset = u.update_id + 1;
      }
    }
  });
}

/** `text` with what the Bot API's HTML reads as markup escaped (core.telegram.org/bots/api#html-style). */
const escaped = (text: string) =>
  text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);

/** The characters the Bot API counts in `html` once it has parsed it. */
const shown = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&[a-z]+;/g, "-").length;

/**
 * Sends `words`, as Telegram's own styled text in the Bot API's HTML, and then `files`, each as a document,
 * from Telegram door `set`'s bot to its person, and shows typing again if a run there still goes on. Words
 * longer than one message are split between paragraphs into as few messages as fit. The send it returns goes
 * on where a try before it stopped, so what went out goes once.
 */
export function telegramOut(c: Coworker, set: Door, words: string, files: string[]) {
  const html = chatText(words, {
    bold: (w) => `<b>${w}</b>`,
    italic: (w) => `<i>${w}</i>`,
    struck: (w) => `<s>${w}</s>`,
    link: (w, href) => `<a href="${escaped(href)}">${w}</a>`,
    text: escaped,
  });
  const parts: string[] = [];
  for (const block of html.split("\n\n").filter(Boolean)) {
    const joined = parts.length > 0 ? `${parts.at(-1)}\n\n${block}` : block;
    if (parts.length > 0 && shown(joined) <= LONGEST) parts[parts.length - 1] = joined;
    else parts.push(block);
  }
  const chat_id = secret(c.setup, set.auth as string);
  let [said, sent] = [0, 0];
  return async () => {
    for (; said < parts.length; said++)
      await bot(c, set, "sendMessage", { chat_id, text: parts[said], parse_mode: "HTML" });
    for (; sent < files.length; sent++) {
      const form = new FormData();
      form.append("chat_id", chat_id);
      const f = files[sent] as string;
      form.append("document", new Blob([readFileSync(f)]), basename(f));
      await bot(c, set, "sendDocument", form);
    }
    typists.get(set)?.();
  };
}

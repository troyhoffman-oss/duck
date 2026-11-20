import type { Database } from "bun:sqlite";
import { since } from "./list";
import { ms, type Person } from "./setup";

// SPEC part 10. A row is pending until the main conversation is handed it: sent when its message goes to a
// door, dropped when the main conversation wrote no message for it. An ask row, which duck delivers as
// written, also holds its call as the gate would send it, the archive's id of the message that carried it,
// as `sent_at` when the try that delivered it ended, and once given, the person's answer and the inbox event
// of the message that gave it (SPEC part 9).
export const OUTBOX = `
create table if not exists outbox (id integer primary key, kind text not null check (kind in ('tell', 'ask')),
  text text not null, item_id integer, urgent integer not null default 0, state text not null default 'pending'
  check (state in ('pending', 'sent', 'dropped')), created_at text not null, sent_at text, door text, held text,
  answer text check (answer in ('yes', 'no')), message integer, answered_by integer);`;

export type Row = {
  id: number;
  kind: string;
  text: string;
  item_id: number | null;
  urgent: number;
  created_at: string;
};

/** Writes the "tell" row `input` gives, its `text`, `item_id` and `urgent`, and returns its id. */
export const tell = (db: Database, input: Record<string, unknown>) =>
  (
    db
      .query(
        "insert into outbox (kind, text, item_id, urgent, created_at) values ('tell', ?, ?, ?, ?) returning id",
      )
      .get(
        String(input.text ?? ""),
        input.item_id === undefined ? null : Number(input.item_id),
        input.urgent === true ? 1 : 0,
        new Date().toISOString(),
      ) as { id: number }
  ).id;

/** Writes an ask row with `text`, holding call `held`, and returns its id. */
export const ask = (db: Database, text: string, held: object, urgent: boolean) =>
  (
    db
      .query(
        "insert into outbox (kind, text, urgent, created_at, held) values ('ask', ?, ?, ?, ?) returning id",
      )
      .get(text, urgent ? 1 : 0, new Date().toISOString(), JSON.stringify(held)) as { id: number }
  ).id;

/** The asks the person has been sent and not answered, one line each. */
export const openAsks = (db: Database) =>
  db
    .query<Row, []>(
      "select * from outbox where kind = 'ask' and state = 'sent' and answer is null order by id",
    )
    .all()
    .map((r) => `- ask ${r.id}: ${r.text}`);

/** A note for each ask the person's messages, inbox events `ids`, answered, for the person named `name`. */
export const answeredBy = (db: Database, ids: number[], name: string) =>
  db
    .query<{ id: number; answer: string }, number[]>(
      `select id, answer from outbox where answered_by in (${ids.map(() => "?").join(", ")}) order by id`,
    )
    .all(...ids)
    .map(
      (a) =>
        `Note from duck: ${name}'s message below answers ask ${a.id}: ${a.answer === "yes" ? "a yes, so duck runs its call once, exactly as shown, and what came of it goes to the conversation that made it" : "a no, so its call is dropped"}.\n\n`,
    )
    .join("");

/** The work lane's own tool (SPEC part 10), which the gate serves as duck's own. */
export const TELL = {
  name: "tell",
  description:
    "Tells your person something from this run, which nothing else you write here does. It waits in the outbox until your main conversation writes them one message for everything waiting. `item_id` names the item it is about. `urgent` lets it through their quiet hours and their limit on how often they hear from you; mark it urgent when they asked to be told it at a set time, or when it is of use to them only before a time that comes sooner than they would next hear from you, as a brief before a meeting is, and otherwise only as their standing words allow.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" }, item_id: { type: "integer" }, urgent: { type: "boolean" } },
    required: ["text"],
  },
};

/** When the quiet hours `person` is in at `now` began, or null outside them. */
export function quietSince(person: Person, now = Date.now()) {
  const at = new Intl.DateTimeFormat("en-GB", {
    timeZone: person.zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  if (!person.quiet) return null;
  const [from, to] = person.quiet;
  if (!(from <= to ? from <= at && at < to : at >= from || at < to)) return null;
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  return now - (now % 60_000) - ((minutes(at) - minutes(from) + 1440) % 1440) * 60_000;
}

/**
 * The pending rows that may go to `person` at `now`, and how long until the rest may: urgent rows go at
 * once, the others outside the person's quiet hours and at most one message per `one_message_per`. While
 * `held`, as while the coworker is paused or catching up, only an urgent ask goes: one raised in a run its
 * person is in.
 */
export function due(db: Database, person: Person, now = Date.now(), held = false) {
  const rows = db.query<Row, []>("select * from outbox where state = 'pending' order by id").all();
  const quiet = held || quietSince(person, now) !== null;
  // The limit counts the main conversation's messages; an ask goes as written, beside them.
  const last = db
    .query<{ at: string | null }, []>(
      "select max(sent_at) as at from outbox where state = 'sent' and kind = 'tell' and not urgent",
    )
    .get()?.at;
  // Quiet hours are looked at again each minute. SPEC part 10 gives the limit's default, an hour.
  const wait = quiet ? 60_000 : last ? Date.parse(last) + ms(person.one_message_per ?? "1h") - now : 0;
  const may = (r: Row) => (held ? r.kind === "ask" && r.urgent : r.urgent || wait <= 0);
  return { rows: rows.filter(may), wait: rows.length > 0 ? wait : 0 };
}

/**
 * Rows `ids` as the main conversation or the dispatcher left them: sent to `door` at `now`, or with no time
 * yet, in the archive's message `message` if given; or with no door, dropped.
 */
export function settle(
  db: Database,
  ids: number[],
  door: string | null,
  now: number | null = Date.now(),
  message?: number,
) {
  for (const id of ids)
    db.run("update outbox set state = ?, sent_at = ?, door = ?, message = ? where id = ?", [
      door ? "sent" : "dropped",
      door && now !== null ? new Date(now).toISOString() : null,
      door,
      message ?? null,
      id,
    ]);
}

/**
 * The note that hands `rows` to the main conversation, for the person named `name`. A row waits, so each
 * shows when it was written and, under it, its item as it stands now and what the item's log gained since.
 */
export const tells = (db: Database, rows: Row[], name: string) =>
  rows.length === 0
    ? ""
    : `Note from duck: your work lane wrote these for ${name} at the times they start with. Under one about an item is the item as it stands now and what its log gained since. Write them one message about what is true now: what came in, what you did, and anything you held and why. One whose item has since settled is not told; when every one has, write nothing, and nothing is sent.\n${rows
        .map((r) =>
          [
            `- ${r.created_at}: ${r.urgent ? "urgent: " : ""}${r.text}${r.item_id ? ` (item ${r.item_id})` : ""}`,
            ...(r.item_id ? since(db, r.item_id, r.created_at) : []).map((l) => `  ${l}`),
          ].join("\n"),
        )
        .join("\n")}\n\n`;

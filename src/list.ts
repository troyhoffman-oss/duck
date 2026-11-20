import type { Database } from "bun:sqlite";

const STATES = ["open", "waiting", "done", "dropped"];
export const KINDS = ["mail_thread", "draft", "file", "job", "meeting", "call"];
const among = (values: string[]) => values.map((v) => `'${v}'`).join(", ");

// SPEC part 7. An item is never deleted: done and dropped close it. The search index holds no copy of an
// item, only its words (an external-content table), and the triggers keep it in step.
export const LIST = `
create table if not exists items (id integer primary key, title text not null,
  state text not null default 'open' check (state in (${among(STATES)})), holder text, next text, due text,
  body text, created_at text not null, updated_at text not null);
create table if not exists links (item_id integer not null, kind text not null check (kind in (${among(KINDS)})),
  ref text not null, label text, added_at text not null, added_by text not null);
create index if not exists links_kind_ref on links (kind, ref);
create table if not exists log (item_id integer not null, at text not null,
  by text not null check (by in ('code', 'coworker', 'person')), text text not null);
create virtual table if not exists items_text using fts5(title, next, body, content = items, content_rowid = id);
create trigger if not exists items_written after insert on items begin
  insert into items_text (rowid, title, next, body) values (new.id, new.title, new.next, new.body); end;
create trigger if not exists items_changed after update on items begin
  insert into items_text (items_text, rowid, title, next, body) values ('delete', old.id, old.title, old.next, old.body);
  insert into items_text (rowid, title, next, body) values (new.id, new.title, new.next, new.body); end;`;

const FIELDS = ["title", "state", "holder", "next", "due", "body"] as const;

export type Item = Record<(typeof FIELDS)[number] | "created_at" | "updated_at", string | null> & {
  id: number;
};

/** A link to add to an item: its kind, the thing's ref and a short label, if any. */
export type Link = { kind: string; ref: string; label?: string };

/** What `write_item` takes: the items columns, the links to add and a line for the item's log. */
type ItemInput = Partial<Record<(typeof FIELDS)[number], string | null>> & {
  id?: number;
  links?: Link[];
  log?: string;
};

/** Adds each of `links` the item has not yet to item `item`, as added by `by`, code or coworker. */
export function link(db: Database, item: number, links: Link[], by: string) {
  for (const l of links)
    db.run(
      `insert into links (item_id, kind, ref, label, added_at, added_by) select ?1, ?2, ?3, ?4, ?5, ?6
        where not exists (select 1 from links where item_id = ?1 and kind = ?2 and ref = ?3)`,
      [item, l.kind, l.ref, l.label ?? null, new Date().toISOString(), by],
    );
}

/** Adds `text` to item `item`'s log, as written by `by`. */
export const logged = (db: Database, item: number, text: string, by = "code") =>
  db.run("insert into log (item_id, at, by, text) values (?, ?, ?, ?)", [
    item,
    new Date().toISOString(),
    by,
    text,
  ]);

/** The item one of `refs` was last linked to, if any. */
export const linkedTo = (db: Database, refs: string[]) =>
  db
    .query<{ item_id: number }, string[]>(
      `select item_id from links where ref in (${refs.map(() => "?").join(", ")}) order by rowid desc limit 1`,
    )
    .get(...refs)?.item_id;

/** Writes a new item, or with `id` changes only the fields given, and returns the item's id. */
export function writeItem(db: Database, input: ItemInput): number {
  return db.transaction(() => {
    const at = new Date().toISOString();
    const given = FIELDS.filter((f) => f in input);
    const values = given.map((f) => input[f] ?? null);
    let id = input.id;
    if (id === undefined) {
      const columns = [...given, "created_at", "updated_at"];
      id = (
        db
          .query(
            `insert into items (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")}) returning id`,
          )
          .get(...values, at, at) as { id: number }
      ).id;
    } else {
      const set = [...given, "updated_at"].map((f) => `${f} = ?`).join(", ");
      if (db.run(`update items set ${set} where id = ?`, [...values, at, id]).changes === 0)
        throw new Error(`there is no item ${id}`);
    }
    link(db, id, input.links ?? [], "coworker");
    if (input.log) logged(db, id, input.log, "coworker");
    return id;
  })();
}

/** An item on one line: its id, title and state, and who holds it, its next step and when it is due. */
const line = (i: Item) =>
  [
    `${i.id}. ${i.title}`,
    i.state,
    ...(["holder", "next", "due"] as const).flatMap((f) => (i[f] ? `${f}: ${i[f]}` : [])),
  ].join(" · ");

/** One line per open item, open or waiting, oldest first: what every run loads (SPEC part 5). */
export const openItems = (db: Database) =>
  db.query<Item, []>("select * from items where state in ('open', 'waiting') order by id").all().map(line);

/** The items its person's To-dos show: the open and waiting ones, and those done in the last 7 days. */
export const shown = (db: Database) =>
  db
    .query<Item, [string]>(
      "select * from items where state in ('open', 'waiting') or (state = 'done' and updated_at > ?) order by id",
    )
    .all(new Date(Date.now() - 7 * 86_400_000).toISOString());

/** The dated lines the logs of the open items gained after `after`, oldest first, each with its item's id. */
export const gained = (db: Database, after: string) =>
  db
    .query<Record<string, string>, [string]>(
      `select log.* from log join items on items.id = log.item_id where state in ('open', 'waiting') and at > ?
        order by at, log.rowid`,
    )
    .all(after)
    .map((l) => `- item ${l.item_id}, ${l.at}, ${l.by}: ${l.text}`);

/** Item `id`'s dated log lines after `after`, oldest first. */
const logOf = (db: Database, id: number, after = "") =>
  db
    .query<Record<string, string>, [number, string]>(
      "select * from log where item_id = ? and at > ? order by at, rowid",
    )
    .all(id, after)
    .map((l) => `- ${l.at}, ${l.by}: ${l.text}`);

/** Item `id` on one line as it stands now, then what its log gained after `after`; nothing for no such item. */
export function since(db: Database, id: number, after: string) {
  const item = db.query<Item, [number]>("select * from items where id = ?").get(id);
  return item ? [`now: ${line(item)}`, ...logOf(db, id, after)] : [];
}

/** Item `id` as one plain document: its facts, its links, its dated log and its timers. */
function document(db: Database, id: number) {
  const item = db.query<Item, [number]>("select * from items where id = ?").get(id);
  if (!item) throw new Error(`there is no item ${id}`);
  const links = db
    .query<Record<string, string>, [number]>("select * from links where item_id = ? order by rowid")
    .all(id)
    .map(
      (l) => `- ${l.kind} ${l.ref}${l.label ? ` (${l.label})` : ""}, added ${l.added_at} by ${l.added_by}`,
    );
  const log = logOf(db, id);
  const timers = db
    .query<Record<string, string>, [number]>(
      "select * from timers where item_id = ? and at is not null order by at",
    )
    .all(id)
    .map((t) => `- timer ${t.id} at ${t.at}${t.repeat ? `, repeating ${t.repeat}` : ""}: ${t.note}`);
  const facts = (["state", "holder", "next", "due", "created_at", "updated_at"] as const).flatMap((f) =>
    item[f] ? `${f}: ${item[f]}` : [],
  );
  const section = (head: string, lines: string[]) => (lines.length > 0 ? [head, ...lines].join("\n") : "");
  return [
    [`# ${item.id}. ${item.title}`, ...facts].join("\n"),
    item.body,
    section("Links:", links),
    section("Log:", log),
    section("Timers:", timers),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const text = { type: "string" };

/** The list's tools, which the gate serves as duck's own. */
export const LIST_TOOLS = [
  {
    name: "write_item",
    description:
      "Writes an item on your list: a new one, or with `id` the item it names, changing only the fields given. duck links what your tools make for the item, such as a draft or a job, and logs what happens to it, such as a draft sent or a reply on its thread; you write what you decide. `state` is open, waiting, done or dropped; done and dropped close it. `holder` is who has the next step. `log` adds a dated line of your judgment to its log. `links` adds a pointer that takes judgment, such as the thread of a mail the item is about; a later event about a linked thing comes to the item. The result names the item's id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        title: text,
        state: { type: "string", enum: STATES },
        holder: text,
        next: text,
        due: text,
        body: text,
        links: {
          type: "array",
          items: {
            type: "object",
            properties: { kind: { type: "string", enum: KINDS }, ref: text, label: text },
            required: ["kind", "ref"],
          },
        },
        log: text,
      },
    },
  },
  {
    name: "read_list",
    description:
      "Reads your list. With `id`, that item as one document: its facts, links, dated log and timers. With `query`, one line for each item whose title, next step or body matches it, open or closed, in SQLite FTS5 query syntax. With neither, one line for each open item.",
    inputSchema: { type: "object", properties: { id: { type: "integer" }, query: text } },
  },
];

/** Runs list tool `name` with `input` and returns its result's words; `wrote` is given the item it wrote. */
export function useList(
  db: Database,
  name: string,
  input: Record<string, unknown>,
  wrote = (_item: number) => {},
): string {
  if (name === "write_item") {
    const id = writeItem(db, input as ItemInput);
    wrote(id);
    return `Item ${id} is written.`;
  }
  if (input.id !== undefined) return document(db, Number(input.id));
  const found =
    input.query === undefined
      ? openItems(db)
      : db
          .query<Item, [string]>(
            "select items.* from items_text join items on items.id = items_text.rowid where items_text match ? order by rank",
          )
          .all(String(input.query))
          .map(line);
  return found.length > 0 ? found.join("\n") : "No item matches.";
}

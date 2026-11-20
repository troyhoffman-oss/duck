import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ARCHIVE } from "./archive";
import { boxesOf, callPlug, fields, session as plugSession } from "./gate";
import { JOBS } from "./jobs";
import { LIST, logged } from "./list";
import { OUTBOX } from "./outbox";
import { factsOf, gives, ms, type Setup, secret } from "./setup";
import { logLine, SORTER } from "./sorter";
import { TIMERS } from "./timers";

/** An inbox row (SPEC part 2). `state` is pending, running or done. */
export type Event = {
  id: number;
  source: string;
  ref: string;
  /** What the event is about, if its source says: the ref of the thread, folder, meeting or call it belongs to. */
  about: string | null;
  received_at: string;
  state: string;
  item_id: number | null;
  session: string | null;
  /** JSON: what a plug's event holds, or for a message at a buzz door, where in Buzz the person wrote it. */
  payload: string | null;
  /** The sorter's answer and reason, where it screened the event (SPEC part 4). */
  answer?: string | null;
  why?: string | null;
};

/**
 * The columns added to a table since the first database of a running coworker was made, as table, column and
 * its definition, oldest first. A pull request that adds a column to a table adds a line here.
 */
const ADDED: [string, string, string][] = [
  ["inbox", "about", "text"],
  ["messages", "author", "text"],
  ["jobs", "title", "text"],
  ["jobs", "started_at", "text"],
  ["jobs", "since", "text"],
];

/** A coworker's database file, with its tables made, and an earlier build's brought up to them. */
export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  // A reader outside duck, such as the admin, reads while duck writes; a writer outside it, such as an
  // import, makes duck wait its turn rather than fail.
  db.exec(`pragma busy_timeout = 30000; pragma journal_mode = wal; create table if not exists inbox (id integer primary key, source text not null, ref text not null,
    about text, received_at text not null, state text not null default 'pending', item_id integer, session text,
    payload text, unique (source, ref));${ARCHIVE}${JOBS}${LIST}${OUTBOX}${SORTER}${TIMERS}`);
  for (const [table, column, definition] of ADDED)
    if (!db.query("select 1 from pragma_table_info(?) where name = ?").get(table, column))
      db.exec(`alter table ${table} add column ${column} ${definition}`);
  return db;
}

/**
 * Writes an event, on item `item`, for session `session` and about `about` if given, unless `source` already
 * sent `ref`; returns its id, or null for a repeat.
 */
export const add = (
  db: Database,
  source: string,
  ref: string,
  payload: string | null = null,
  item: number | null = null,
  session: string | null = null,
  about: string | null = null,
) =>
  db
    .query<{ id: number }, (string | number | null)[]>(
      "insert into inbox (source, ref, about, received_at, payload, item_id, session) values (?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id",
    )
    .get(source, ref, about, new Date().toISOString(), payload, item, session)?.id ?? null;

const among = (sources: string[], not = false) =>
  `source ${not ? "not in" : "in"} (${sources.map(() => "?").join(", ")})`;

/**
 * The events no run has finished, with the sorter's answers, pending or running when a restart cut their
 * run: from `sources` or for session `main`, and with `theirs`, in a session an event from `sources` is in;
 * or `not` those. The person lane's are from its doors or for the main conversation, the others lane's from
 * its doors' others or in their sessions, and the work lane's are the rest.
 */
export const waiting = (
  db: Database,
  sources: string[],
  main: string | undefined,
  not = false,
  theirs = false,
) =>
  db
    .query<Event, (string | null)[]>(
      `select inbox.*, answer, why from inbox left join sorter on event = inbox.id where state != 'done'
        and ${not ? "not " : ""}(${among(sources)} or coalesce(session = ?, 0)${theirs ? ` or coalesce(session in (select session from inbox where ${among(sources)}), 0)` : ""}) order by id`,
    )
    .all(...sources, main ?? null, ...(theirs ? sources : []));

export function mark(db: Database, ids: number[], state: string, session?: string) {
  for (const id of ids)
    db.run("update inbox set state = ?, session = coalesce(?, session) where id = ?", [
      state,
      session ?? null,
      id,
    ]);
}

/**
 * Attaches each unfinished event not from `doors` whose `ref`, or what it is about, is linked to an item to
 * that item (SPEC part 4), and logs on the item what came in, in the words a run is shown it (SPEC part 7).
 */
export function attach(db: Database, doors: string[]) {
  const attached = db
    .query<Event, string[]>(
      `update inbox set item_id = (select item_id from links where links.ref in (inbox.ref, inbox.about) order by rowid desc
        limit 1) where item_id is null and state != 'done' and ${among(doors, true)} returning *`,
    )
    .all(...doors);
  for (const e of attached) if (e.item_id !== null) logged(db, e.item_id, logLine(e));
}

/** The item session `s`'s latest event on an item is on, if any. */
export const sessionItem = (db: Database, s: string) =>
  db
    .query<Event, [string]>(
      "select * from inbox where session = ? and item_id is not null order by id desc limit 1",
    )
    .get(s)?.item_id ?? undefined;

/** The latest session item `id` was worked in, other than `not`: where its work goes on (SPEC part 5). */
export const itemSession = (db: Database, id: number | null, not?: string) =>
  db
    .query<Event, [number | null, string | null]>(
      "select * from inbox where item_id = ? and session is not null and session is not ? order by id desc limit 1",
    )
    .get(id, not ?? null)?.session ?? undefined;

/**
 * The session the latest run of an event from `source` about `about`, or with `under` about anything that
 * starts with it, worked in: where its thread goes on.
 */
export const aboutSession = (db: Database, source: string, about: string, under = false) =>
  db
    .query<Event, [string, string, number]>(
      "select * from inbox where source = ?1 and (about = ?2 or (?3 and substr(about, 1, length(?2)) = ?2)) and session is not null order by id desc limit 1",
    )
    .get(source, about, under ? 1 : 0)?.session ?? undefined;

/** The latest event in session `s` that someone other than the person wrote at a buzz door: who, and where. */
export const othersIn = (db: Database, s: string) =>
  db
    .query<Event, [string]>(
      "select * from inbox where session = ? and source like '%:others' order by id desc limit 1",
    )
    .get(s);

/**
 * Who wrote the events from others that the latest run in session `s` began with, as the person is told: each
 * by the name they give in Buzz, if any, and the start of the key the relay bears out, in brackets; or nothing.
 */
export function othersWho(db: Database, s: string) {
  const who = db
    .query<{ payload: string }, [string]>(
      `select payload from inbox where source like '%:others' and id in
        (select value from json_each((select events from runs where session = ? order by id desc limit 1)))`,
    )
    .all(s)
    .map((e) => {
      const { from = "", key = "" } = JSON.parse(e.payload) as { from?: string; key?: string };
      // buzz-acp gives a writer as "<name> (npub: <npub>, hex: <key>)", or with no name "<npub> (hex: <key>)".
      const name = /^(.*) \(npub: /.exec(from)?.[1];
      return `${name ? `"${name}", ` : ""}Buzz key ${key.slice(0, 8)}`;
    });
  return who.length > 0 ? ` (${[...new Set(who)].join("; ")})` : "";
}

/** The latest event from `sources`: its source is the door where the person last wrote, its payload where. */
export const lastEvent = (db: Database, sources: string[]) =>
  db
    .query<Event, string[]>(`select * from inbox where ${among(sources)} order by id desc limit 1`)
    .get(...sources);

/**
 * The session the latest run of an event from `sources` worked in: for doors, the main conversation. One
 * that has only ever written to the person is found by its messages.
 */
export const lastSession = (db: Database, sources: string[]) =>
  db
    .query<Event, string[]>(
      `select * from inbox where session is not null and ${among(sources)} order by id desc limit 1`,
    )
    .get(...sources)?.session ??
  db
    .query<{ session: string }, []>(
      "select session from messages where way = 'out' and source is null and session is not null limit 1",
    )
    .get()?.session;

/** An event as a plug gives it, with what it is about and the person it is for, where it says. */
export type Pushed = { ref: string; about?: string; payload?: unknown; person?: string };

/**
 * Writes plug `plug`'s event to the inbox of each coworker it is given to, or where it names a person, of
 * that person's, and says how many coworkers it reached and how many of them did not have it yet.
 */
type Arrive = (plug: string, event: Pushed) => { reached: number; added: number };

/**
 * A pushed event as a plug with no box that shapes one sends it: JSON of `ref`, `payload` and, where it says,
 * `about` and `person`, with its push key as a bearer token.
 */
function bearer(body: string, headers: Headers, key: string): Pushed {
  if (headers.get("authorization") !== `Bearer ${key}`) throw new Error("wrong key");
  return JSON.parse(body);
}

/**
 * The inbox handler (SPEC part 2): takes an event plug `name` pushes, shaped by the plug's box that shapes
 * events or else sent with its push key, and answers at once. One that reaches no coworker is answered 404.
 */
export async function push(setup: Setup, name: string, request: Request, arrive: Arrive) {
  const plug = setup.plugs?.[name];
  if (!plug?.events?.push || request.method !== "POST") return new Response("not found", { status: 404 });
  const shape = (await boxesOf(plug)).find((box) => box.event)?.event ?? bearer;
  let event: Pushed | undefined;
  try {
    event = await shape(await request.text(), request.headers, secret(setup, plug.events.push));
  } catch (error) {
    console.error(`plug ${name}'s push is refused: ${(error as Error).message}`);
    return new Response("wrong key", { status: 401 });
  }
  if (!event) return new Response(null, { status: 202 });
  const { reached, added } = arrive(name, event);
  if (reached === 0)
    return new Response(`no coworker plug ${name} is given to works for ${event.person}`, { status: 404 });
  return Response.json({ duplicate: added === 0 }, { status: 202 });
}

/**
 * Calls the list tool of each plug that is polled, on its interval (SPEC part 1), as each running coworker in
 * `coworkers` it is given to, through the gate's call so the plug's boxes shape its result: each row it lists
 * is an event for that coworker's person, whose `ref` is the row's id field and what it is about the row's
 * about field, where setup names one, and whose payload is the rest of the row.
 */
export function poll(setup: Setup, coworkers: ReadonlyMap<string, unknown>, arrive: Arrive) {
  for (const [name, plug] of Object.entries(setup.plugs ?? {})) {
    const p = plug.events?.poll;
    if (!p) continue;
    const list = async (coworker: string) => {
      const send = await plugSession(setup, plug, coworker);
      const result = await callPlug(setup, coworker, name, send, p.tool, {}, [], []);
      for (const row of fields(result) as Record<string, unknown>[])
        arrive(name, {
          ref: row[p.id] as string,
          about: p.about === undefined ? undefined : (row[p.about] as string | undefined),
          payload: Object.fromEntries(Object.entries(row).filter(([k]) => k !== p.id && k !== p.about)),
          person: factsOf(setup, coworker).handle ?? undefined,
        });
    };
    setInterval(() => {
      for (const c of [...coworkers.keys()].filter((c) => gives(plug, c)))
        list(c).catch((error: Error) =>
          console.error(`the poll of plug ${name} for ${c} failed: ${error.message}`),
        );
    }, ms(p.every));
  }
}

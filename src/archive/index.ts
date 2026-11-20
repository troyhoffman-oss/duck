import type { Database } from "bun:sqlite";

// SPEC part 13: every message in and out, every run and every tool call, kept per coworker. A message from
// before duck names its `source`, its own id there, `ref`, and its `author` when someone other than the
// person wrote it. The search index holds only the messages' words, kept in step by a trigger, so a message
// `duck import` loads is searched as well.
export const ARCHIVE = `
create table if not exists messages (id integer primary key, at text not null, way text not null, door text not null,
  event integer, session text, text text not null, files text not null, source text, ref text, author text,
  unique (source, ref));
create table if not exists runs (id integer primary key, session text not null, started_at text not null,
  ended_at text, events text not null, stop text);
create table if not exists tool_calls (id text primary key, run integer not null, at text not null,
  tool text not null, input text, status text);
create virtual table if not exists messages_text using fts5(text, content = messages, content_rowid = id);
create trigger if not exists messages_written after insert on messages begin
  insert into messages_text (rowid, text) values (new.id, new.text); end;`;

const now = () => new Date().toISOString();

/**
 * Keeps a person's message, the text of inbox event `event`, with the paths of its files, as written at `at`:
 * the door's own time where it gives one, else now.
 */
export const heard = (db: Database, door: string, event: number, text: string, files: string[], at = now()) =>
  db.run("insert into messages (at, way, door, event, text, files) values (?, 'in', ?, ?, ?, ?)", [
    at,
    door,
    event,
    text,
    JSON.stringify(files),
  ]);

/** Keeps a message to the person and returns its id, which its delivery carries. */
export const told = (db: Database, door: string, session: string | null, text: string, files: string[]) =>
  Number(
    db.run("insert into messages (at, way, door, session, text, files) values (?, 'out', ?, ?, ?, ?)", [
      now(),
      door,
      session,
      text,
      JSON.stringify(files),
    ]).lastInsertRowid,
  );

/** What the person wrote in events `ids`, with the paths of the files they sent. */
export function said(db: Database, ids: number[]) {
  const rows = db
    .query<{ text: string; files: string }, number[]>(
      `select text, files from messages where way = 'in' and event in (${ids.map(() => "?").join(", ")}) order by id`,
    )
    .all(...ids);
  return rows
    .map((r) => {
      const files = JSON.parse(r.files) as string[];
      return files.length > 0 ? `${r.text}\n\nFiles: ${files.join(", ")}` : r.text;
    })
    .join("\n\n");
}

/** The last few messages sent to the person, by any path, oldest first: "already told" (SPEC part 10). */
export const lastTold = (db: Database) =>
  db
    .query<{ at: string; text: string }, []>(
      "select at, text from (select * from messages where way = 'out' order by at desc, id desc limit 5) order by at, id",
    )
    .all()
    .map((m) => `- ${m.at}: ${m.text}`);

export const runStarted = (db: Database, session: string, events: number[]) =>
  Number(
    db.run("insert into runs (session, started_at, events) values (?, ?, ?)", [
      session,
      now(),
      JSON.stringify(events),
    ]).lastInsertRowid,
  );

/** Ends `run`, and the runs a restart cut short in its session, whose calls it was told of. */
export function runEnded(db: Database, run: number, events: number[], stop: string) {
  const at = now();
  db.run(
    "update runs set ended_at = ?1, stop = 'cut' where session = (select session from runs where id = ?2) and id < ?2 and ended_at is null",
    [at, run],
  );
  db.run("update runs set ended_at = ?, events = ?, stop = ? where id = ?", [
    at,
    JSON.stringify(events),
    stop,
    run,
  ]);
}

/** The run session `s` is in, if one is. */
export const openRun = (db: Database, s: string) =>
  db
    .query<{ id: number }, [string]>(
      "select id from runs where session = ? and ended_at is null order by id desc limit 1",
    )
    .get(s)?.id;

/** When session `s`'s latest run started: when it was last shown what every run loads. */
export const lastShown = (db: Database, s: string) =>
  db.query<{ at: string | null }, [string]>("select max(started_at) as at from runs where session = ?").get(s)
    ?.at ?? undefined;

/** Keeps tool call `id`, made in the run `session` is in, before anything comes of it. */
export const called = (db: Database, session: string, id: string, tool: string, input: unknown) =>
  db.run(
    `insert or replace into tool_calls (id, run, at, tool, input) select ?, id, ?, ?, ? from runs
      where session = ? and ended_at is null order by id desc limit 1`,
    [id, now(), tool, JSON.stringify(input ?? null), session],
  );

export const callStatus = (db: Database, id: string, status: string) =>
  db.run("update tool_calls set status = ? where id = ?", [status, id]);

/**
 * The tool calls that have no known result in `session`'s runs a restart cut short, each as its tool's name
 * and its input. A cut run stays open until a run started after it ends, so a run cut before it ends is
 * followed by one told of both runs' calls.
 */
export const cutShort = (db: Database, session: string): string[] =>
  db
    .query<{ tool: string; input: string }, [string]>(
      `select tool, input from tool_calls where run in (select id from runs where session = ? and ended_at is null)
        and coalesce(status, '') not in ('completed', 'failed') order by at`,
    )
    .all(session)
    .map((r) => `${r.tool} ${r.input}`);

const [ROWS, CHARS] = [30, 1000];

/** The archive's one tool (SPEC part 13), which the gate serves as duck's own on the person and work lanes. */
export const ARCHIVE_TOOL = {
  name: "read_archive",
  description: `Reads the archive: every message between you and your person, and those loaded from products they used before you, oldest first. With \`query\`, plain words, only the messages that hold every one of them; each word is matched as written, as a whole word, with no search syntax. With \`session\`, only that conversation's. With \`from\` or \`to\`, ISO 8601 times, only those from or until then. Each line gives a message's time, who wrote it, its door or earlier product, its session and its first ${CHARS} characters; a longer one's line ends with its id, and \`message\` set to that id shows it whole. A call shows at most ${ROWS} messages, oldest first: the first ${ROWS} from \`from\`, or with \`to\` the last ${ROWS} until it; fewer means none lie beyond them that way. To read on, call again with \`from\` set to the last time shown, or to read back, with \`to\` set to the first; that message is shown again. To read the stretch around a message, give its session and a \`from\` a little before its time.`,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      session: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      message: { type: "integer" },
    },
  },
};

type Message = {
  id: number;
  at: string;
  way: string;
  door: string;
  source: string | null;
  author: string | null;
  session: string | null;
  text: string;
};

/** Runs the archive's tool with `input` for the person named `person`, and returns its result's words. */
export function readArchive(db: Database, person: string, input: Record<string, unknown>) {
  const time = (t: unknown) => (t === undefined ? null : new Date(String(t)).toISOString());
  const back = input.to === undefined ? "" : "desc";
  // Each word is an FTS5 string, so no character in it is syntax, and FTS5 requires every one.
  const words = String(input.query ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `"${w.replaceAll('"', '""')}"`)
    .join(" ");
  // A person's message is in the session of the run that read it.
  const found = db
    .query<Message, (string | number | null)[]>(
      `select * from (select m.at, m.id, m.way, m.door, m.source, m.author, coalesce(m.session, i.session) as session, m.text
        from messages m left join inbox i on i.id = m.event where (?3 is null or m.at >= ?3) and (?4 is null or m.at <= ?4)
        and (?5 is null or m.id = ?5)
        and (?1 is null or m.id in (select rowid from messages_text where messages_text match ?1)))
        where ?2 is null or session = ?2 order by at ${back}, id ${back} limit ${ROWS}`,
    )
    .all(
      words || null,
      (input.session as string) ?? null,
      time(input.from),
      time(input.to),
      (input.message as number) ?? null,
    );
  if (back) found.reverse();
  const cut = (m: Message) =>
    input.message === undefined && m.text.length > CHARS
      ? `${m.text.slice(0, CHARS)}… (cut from ${m.text.length} characters; read it whole with message ${m.id})`
      : m.text;
  const line = (m: Message) =>
    `- ${m.at}, ${m.way === "in" ? `${m.author ?? person} wrote` : `to ${person}`} at ${m.door}${m.source ? `, loaded from ${m.source}` : ""}${m.session ? `, session ${m.session}` : ""}: ${cut(m)}`;
  return found.length > 0 ? found.map(line).join("\n") : "No message matches.";
}

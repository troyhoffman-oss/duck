import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importHistory } from "../../src/archive/history";
import { openDb } from "../../src/inbox";

const EXPORTS = join(import.meta.dir, "..", "kit", "exports");
const file = (name: string) => join(EXPORTS, name);

/** The SQLite file a source writes, made from the kit's made-up one in SQL. */
function sqlite(name: string) {
  const path = join(mkdtempSync(join(tmpdir(), "export-")), name.replace(/\.sql$/, ".db"));
  const db = new Database(path);
  db.exec(readFileSync(file(name), "utf8"));
  db.close();
  return path;
}

type Row = {
  session: string;
  ref: string;
  way: string;
  at: string;
  door: string;
  text: string;
  files: string;
};
const archived = (db: Database) =>
  db
    .query<Row, []>("select session, ref, way, at, door, text, files, source from messages order by id")
    .all()
    .map((r) => [r.way, r.at, r.text, JSON.parse(r.files)]);

/** Loads an export twice: what the first load kept, after checking the second added nothing. */
function loadTwice(kind: string, path: string) {
  const db = openDb(":memory:");
  importHistory(db, kind, path);
  const kept = archived(db);
  importHistory(db, kind, path);
  expect(archived(db)).toEqual(kept);
  return { kept, db };
}

test("a Claude export loads the person's words and the replies on the branch they ended on, once", () => {
  const { kept } = loadTwice("claude", file("claude-conversations.json"));
  expect(kept).toEqual([
    [
      "in",
      "2026-03-02T15:04:05.123Z",
      "Can you draft a note to the dock crew about Friday's inspection?",
      ["inspection-checklist.pdf"],
    ],
    ["out", "2026-03-02T15:04:31.000Z", "Here is a draft:\n\nWant me to shorten it?", []],
    ["in", "2026-03-02T15:07:00.000Z", "Make it shorter and friendlier.", []],
    [
      "out",
      "2026-03-02T15:07:20.500Z",
      "Hi all, quick heads-up: inspection is Friday at 9. Thanks for clearing the ladders!",
      [],
    ],
    ["in", "2026-03-04T11:30:00.000Z", "", ["pier-photo.jpg"]],
    ["out", "2026-03-04T11:30:12.000Z", "That is the north pier at low tide.", []],
  ]);
});

test("a ChatGPT conversation with an edited message and a retried reply loads only its final branch, once", () => {
  const { kept } = loadTwice("chatgpt", file("chatgpt-conversations.json"));
  expect(kept).toEqual([
    [
      "in",
      "2026-03-05T14:00:00.123Z",
      "What is low tide at 6am Saturday, from this table?",
      ["tide-table.png"],
    ],
    ["out", "2026-03-05T14:00:10.000Z", "Low tide Saturday is at 6:12am, 0.3 ft.", []],
    ["in", "2026-03-05T14:03:20.000Z", "And Sunday at 7am, how deep at the north pier?", []],
    [
      "out",
      "2026-03-05T14:05:00.250Z",
      "At 7am Sunday the north pier has about 3.5 ft of water, rising.",
      [],
    ],
    ["in", "2026-04-10T08:15:10.000Z", "What do marinas usually charge per foot for a summer slip?", []],
    ["out", "2026-04-10T08:15:30.000Z", "Often $80 to $150 a foot for the season.", []],
  ]);
});

test("a Hermes store loads its sessions with a person as the person saw them, once; a group chat keeps who wrote each message, and a chat Hermes went on with after a reset is one conversation", () => {
  const path = sqlite("hermes-state.sql");
  const store = new Database(path);
  store.exec(`insert into sessions (id, source, parent_session_id, started_at, chat_type) values
      ('20260503_080000_c1d2e3', 'buzz', null, 1777795200.0, 'group'),
      ('20260504_080000_f4a5b6', 'telegram', '20260501_120000_a1b2c3d4', 1777881600.0, 'dm');
    insert into messages (session_id, role, content, timestamp) values
      ('20260503_080000_c1d2e3', 'user', '[Dana Reyes] Is slip 14 free this weekend?', 1777795200.0),
      ('20260503_080000_c1d2e3', 'user', '[Replying to: "Is slip 14 free?"]\n\n[Rosa Alvarez] Checking, Dana.', 1777795210.0),
      ('20260503_080000_c1d2e3', 'assistant', 'Slip 14 is free both days.', 1777795220.0),
      ('20260504_080000_f4a5b6', 'assistant', 'The fence permit is still pending.', 1777637010.0),
      ('20260504_080000_f4a5b6', 'user', 'Did the fence permit come through?', 1777881600.0);`);
  store.close();
  const { kept, db } = loadTwice("hermes", path);
  expect(kept.slice(0, 7)).toEqual([
    ["in", "2026-05-01T12:00:00.500Z", "Morning! Anything new on the Cole St permit?", []],
    ["out", "2026-05-01T12:00:08.000Z", "The Cole St permit was approved yesterday.", []],
    ["in", "2026-05-01T12:03:20.000Z", "Also check the fence permit.", []],
    ["out", "2026-05-01T12:03:30.000Z", "The fence permit is still pending.", []],
    ["in", "2026-05-01T12:05:30.000Z", "Thank you! Remind me Friday.", []],
    ["in", "2026-05-02T09:00:00.000Z", 'Rename the slip list to "Summer slips".', []],
    ["out", "2026-05-02T09:01:00.250Z", 'Done: it is now "Summer slips".', []],
  ]);
  expect(db.query("select session, author, text from messages where id > 7 order by id").all()).toEqual([
    { session: "20260503_080000_c1d2e3", author: "Dana Reyes", text: "Is slip 14 free this weekend?" },
    {
      session: "20260503_080000_c1d2e3",
      author: "Rosa Alvarez",
      text: '[Replying to: "Is slip 14 free?"]\n\nChecking, Dana.',
    },
    { session: "20260503_080000_c1d2e3", author: null, text: "Slip 14 is free both days." },
    { session: "20260501_120000_a1b2c3d4", author: null, text: "Did the fence permit come through?" },
  ]);
  expect(db.query("select distinct source, door from messages where id <= 7").all()).toEqual([
    { source: "hermes", door: "telegram" },
    { source: "hermes", door: "cli" },
  ]);
});

test("a Hermes session export and its store name the same messages, so loading both adds each once", () => {
  const db = openDb(":memory:");
  importHistory(db, "hermes", file("hermes-sessions.jsonl"));
  expect(archived(db)).toHaveLength(2);
  importHistory(db, "hermes", sqlite("hermes-state.sql"));
  expect(archived(db)).toHaveLength(7);
});

test("imported messages sit beside duck's own, and an export missing a field fails naming it", () => {
  const db = openDb(":memory:");
  db.run(
    "insert into messages (at, way, door, text, files) values ('2026-11-20T09:00:00.000Z', 'in', 'desk', 'hi', '[]')",
  );
  importHistory(db, "chatgpt", file("chatgpt-conversations.json"));
  expect(db.query("select count(*) as n from messages where source is null").get()).toEqual({ n: 1 });
  const broken = join(mkdtempSync(join(tmpdir(), "export-")), "conversations.json");
  const conversations = JSON.parse(readFileSync(file("chatgpt-conversations.json"), "utf8"));
  conversations[1].mapping["c3000000-0000-4000-8000-000000000004"].message.create_time = null;
  writeFileSync(broken, JSON.stringify(conversations));
  expect(() => importHistory(openDb(":memory:"), "chatgpt", broken)).toThrow(
    "the export has a message with no create_time",
  );
});

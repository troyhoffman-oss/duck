import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  all,
  answered,
  call,
  coworkerRun,
  E2E,
  type Firm,
  harbor,
  held,
  said,
  say,
  second,
  shows,
  sorter,
  startFirm,
  TOOLS,
  until,
} from "../kit";
import { authTag } from "../kit/buzz";
import type { When } from "../kit/model";

type Setup = Parameters<Parameters<Firm["reinstall"]>[0]>[0];

const EXPORTS = join(import.meta.dir, "..", "kit", "exports");
/** A work-lane run: only it has `tell` (SPEC part 10). */
const workLane: When = (r) => r.has(TOOLS.tell);
/** A run in the main conversation. */
const main: When = (r) => coworkerRun(r) && !r.has(TOOLS.tell);

/** A coworker's tables as the build at 8bc0b8d made them, the first that ran a coworker for a person. */
const EARLIER = `
create table inbox (id integer primary key, source text not null, ref text not null, received_at text not null,
  state text not null default 'pending', item_id integer, session text, payload text, unique (source, ref));
create table messages (id integer primary key, at text not null, way text not null, door text not null,
  event integer, session text, text text not null, files text not null, source text, ref text, unique (source, ref));
create table runs (id integer primary key, session text not null, started_at text not null, ended_at text,
  events text not null, stop text);
create table tool_calls (id text primary key, run integer not null, at text not null, tool text not null,
  input text, status text);
create virtual table messages_text using fts5(text, content = messages, content_rowid = id);
create trigger messages_written after insert on messages begin
  insert into messages_text (rowid, text) values (new.id, new.text); end;
create table jobs (id integer primary key, item_id integer not null, brief text not null, "check" integer not null,
  check_reason text not null, state text not null default 'running', rounds integer not null default 1,
  session text not null);
create table items (id integer primary key, title text not null,
  state text not null default 'open' check (state in ('open', 'waiting', 'done', 'dropped')), holder text,
  next text, due text, body text, created_at text not null, updated_at text not null);
create table links (item_id integer not null,
  kind text not null check (kind in ('mail_thread', 'draft', 'file', 'job', 'meeting', 'call')), ref text not null,
  label text, added_at text not null, added_by text not null);
create index links_kind_ref on links (kind, ref);
create table log (item_id integer not null, at text not null,
  by text not null check (by in ('code', 'coworker', 'person')), text text not null);
create virtual table items_text using fts5(title, next, body, content = items, content_rowid = id);
create trigger items_written after insert on items begin
  insert into items_text (rowid, title, next, body) values (new.id, new.title, new.next, new.body); end;
create trigger items_changed after update on items begin
  insert into items_text (items_text, rowid, title, next, body) values ('delete', old.id, old.title, old.next, old.body);
  insert into items_text (rowid, title, next, body) values (new.id, new.title, new.next, new.body); end;
create table outbox (id integer primary key, kind text not null check (kind in ('tell', 'ask')), text text not null,
  item_id integer, urgent integer not null default 0, state text not null default 'pending'
  check (state in ('pending', 'sent', 'dropped')), created_at text not null, sent_at text, door text, held text,
  answer text check (answer in ('yes', 'no')));
create table sorter (event integer primary key, answer text not null, why text not null, at text not null);
create table timers (id integer primary key autoincrement, at text, repeat text, item_id integer, note text not null);`;

setDefaultTimeout(E2E);

describe("The admin sets up the firm and changes it", () => {
  let firm: Firm;
  beforeAll(async () => {
    firm = await startFirm({ second: true });
  }, E2E);
  afterAll(() => firm?.[Symbol.asyncDispose](), E2E);
  afterEach(() => firm.step(), E2E);

  test("a database from an earlier build is brought up to date: installed over it, the coworker keeps what it held and takes an event that says what it is about", async () => {
    const OLD = "<deposit-2b@harbor.example>";
    const NEW = {
      ref: "<tips-1120-2@landlordnews.example>",
      about: "thread-landlord-news",
      person: harbor.person,
      payload: { from: "news@landlordnews.example", subject: "More tips for winter", text: "Gutters again." },
    };
    firm.model.on(all(sorter, shows("More tips for winter")), say("noise: a newsletter"));
    // Only the coworker's database is from the earlier build; what else duck keeps for it stays.
    await firm.stop();
    const folder = join(firm.folder, "storage", harbor.coworker);
    for (const file of ["duck.db", "duck.db-wal", "duck.db-shm"]) rmSync(join(folder, file), { force: true });
    const earlier = new Database(join(folder, "duck.db"), { create: true });
    earlier.exec(EARLIER);
    earlier.run(
      "insert into inbox (source, ref, received_at, state, payload) values ('mail', ?, ?, 'done', 'null')",
      [OLD, new Date().toISOString()],
    );
    earlier.close();

    await firm.start();
    expect(await firm.push(NEW)).toEqual({ status: 202, body: { duplicate: false } });
    await until("the sorter's call", () => firm.model.requests.some(sorter), 60, firm.trouble);
    using db = firm.db();
    expect(db.query("select ref, about from inbox order by id").all()).toEqual([
      { ref: OLD, about: null },
      { ref: NEW.ref, about: NEW.about },
    ]);
  });

  test("duck check refuses a setup that lists people or coworkers, as duck install does, and one with an unknown zone, a plug's coworkers that are not a list, a state that is not one, a state on the polled list tool, or a sorter on or in observe with no route to its decision model; a sorter that is off needs none, and the running firm is never touched", async () => {
    const file = join(firm.folder, "duck.yaml");
    const setup = readFileSync(file, "utf8");
    const duck = await firm.duckId();
    /** Runs duck check on the setup as `change` leaves it. */
    const checked = (change: (s: Setup) => void) => {
      const s = Bun.YAML.parse(setup) as Setup;
      change(s);
      writeFileSync(file, Bun.YAML.stringify(s, null, 2));
      return firm.duck("check");
    };
    try {
      appendFileSync(file, "\ncoworkers:\n  wren:\n    person: rosa\n");
      const listed =
        "duck.yaml lists people or coworkers, which duck keeps itself: take them out, make each coworker with duck make and claim it with duck claim";
      await expect(firm.duck("check")).rejects.toThrow(listed);
      await expect(firm.duck("install")).rejects.toThrow(listed);

      for (const mode of ["on", "observe"]) {
        const refused = checked((s) => {
          s.zone = "Mars/Olympus";
          s.plugs.odd = { address: "http://127.0.0.1:9/mcp", coworkers: "wren" as "everyone" };
          (s.plugs.mail as Setup["plugs"][string]).tools = { "*": "sometimes" };
          (s.plugs.calendar as Setup["plugs"][string]).tools = { list_events: "removed" };
          s.sorter.mode = mode;
          delete s.sorter.address;
        });
        for (const problem of [
          `zone is "Mars/Olympus"; it is the firm's time zone, such as America/Chicago`,
          "plug odd's coworkers is everyone or a list of coworkers' names",
          `plug mail's tool * is "sometimes"`,
          "plug calendar's tool list_events is the one duck polls",
          `sorter names no address: the route to its decision model, which mode ${mode} calls`,
        ])
          await expect(refused).rejects.toThrow(problem);
      }
      await checked((s) => {
        s.sorter.mode = "off";
        for (const part of ["address", "key", "model"] as const) delete s.sorter[part];
      });
    } finally {
      writeFileSync(file, setup);
    }
    expect(await firm.duckId()).toBe(duck);
  });

  test("a plug added to the setup reaches the coworker already running and gives only the tools the setup names, `*` removing the rest; duck's log in the new duck container still holds what came before", async () => {
    const [FIRST, ASK] = ["Anything new on 4B?", "What's in the 4B folder?"];
    const replies = async () => (await firm.logged("reply")).length;
    firm.model.on(said(FIRST), say("Nothing new on 4B."));
    firm.model.on(
      all(said(ASK), (r) => r.has("list_files") && !r.has("delete_file") && r.has("find_mail")),
      call("list_files", { folder: "4B" }),
    );
    firm.model.on(answered("list_files"), (r) => say(`The 4B folder holds ${r.last.trim()}.`));

    await firm.person.send("desk", FIRST);
    expect((await firm.person.next(30)).text).toBe("Nothing new on 4B.");
    expect(await replies()).toBe(1);
    const before = await firm.duckId();
    const files = firm.plugIn("files", {
      list_files: { description: "Lists the files in a folder.", answer: () => "lease.pdf" },
      delete_file: { description: "Deletes a file.", answer: () => "deleted" },
    });
    await firm.reinstall((s) => {
      (s.plugs.files as Setup["plugs"][string]).tools = { "*": "removed", list_files: "free" };
    });
    expect(await firm.duckId()).not.toBe(before);

    await firm.person.send("desk", ASK);
    expect((await firm.person.next(60)).text).toBe("The 4B folder holds lease.pdf.");
    expect(files.callsTo("list_files").map((c) => c.input)).toEqual([{ folder: "4B" }]);
    expect(await replies()).toBe(2);
  });

  test("a coworker claimed while another works interrupts nothing: duck install starts only the new coworker, and the others' goose containers, the duck container and the run in progress go on", async () => {
    const ASK = "What's the gate code for 4B?";
    firm.model.on(said(ASK), held("long", say("It's 2468.")));
    await firm.person.send("desk", ASK);
    await firm.model.reached("long");
    const ids = async () => [await firm.duckId(), await firm.duckId(harbor.coworker)];
    const before = await ids();

    // Ana's coworker is given harbor's mail plug, as every coworker is, with her own key for it.
    appendFileSync(join(firm.folder, "secrets.env"), "HARBOR_MAIL_KEY_ana=ana-mail-key\n");
    const key = (
      /its Buzz key is ([0-9a-f]{64})/.exec(await firm.duck("make", "lark", "ana")) as string[]
    )[1];
    const installed = await firm.duck("claim", "lark", authTag(randomBytes(32), key as string), "Ana Ruiz");
    expect(installed).toBe(`${second.coworker}: kept\nlark: started\n${harbor.coworker}: kept\nduck: kept\n`);

    firm.model.release("long");
    expect((await firm.person.next(30)).text).toBe("It's 2468.");
    expect(await ids()).toEqual(before);
  });

  test("a coworker whose goose is lost holds up no other: the second coworker answers meanwhile, and the first comes back to the run it was cut from", async () => {
    const [ASK, THEIRS] = ["What's the gate code for 4B?", "Which unit is vacant?"];
    firm.model.on(said(ASK), held("lost", say("It's 2468.")));
    firm.model.on(said(THEIRS), say("2A is vacant from December."));
    firm.model.on(all(said("cut short"), said(ASK)), say("It's 2468, sorry for the wait."));
    const duck = await firm.duckId();

    await firm.person.send("desk", ASK);
    await firm.model.reached("lost");
    await firm.crashGoose();
    const lost = performance.now();
    await firm.second.send("desk", THEIRS);
    expect((await firm.second.next(30)).text).toBe("2A is vacant from December.");
    expect(firm.person.received.filter((m) => m.at > lost)).toEqual([]);

    await firm.start();
    expect((await firm.person.next(60)).text).toBe("It's 2468, sorry for the wait.");
    firm.model.release("lost");
    await firm.person.quiet(5);
    expect(await firm.duckId()).toBe(duck);
    const losses = (await firm.logs()).split("\n").filter((l) => l.startsWith("lost goose at"));
    expect(losses).toHaveLength(1);
    expect(losses[0]).toContain(`-${harbor.coworker}:`);
  });

  test("history loaded with duck import is dreamed over at once, and what the dream wrote is shown in the main conversation", async () => {
    const ARCHIVE = "read_archive";
    const LOADED = "Can you draft a note to the dock crew about Friday's inspection?";
    const NOTE = "The dock crew's inspection is Fridays at 9. (Rosa, in a Claude chat, 2026-03-02.)";
    const STANDING = "Keep notes to the dock crew short and friendly. (Rosa, in a Claude chat, 2026-03-02.)";
    const ASK = "What do you know about the dock crew?";
    const write = (path: string, content: string) => call("write", { path: `/duck/home/${path}`, content });
    firm.model.on(all(workLane, said("dreaming.md")), (r) =>
      call("shell", { command: `cat ${/\/\S+dreaming\.md/.exec(r.last)?.[0]}` }),
    );
    firm.model.on(all(answered("shell"), said("# Dreaming")), call(ARCHIVE, { query: "inspection" }));
    firm.model.on(
      all(
        answered(ARCHIVE),
        said(`wrote at claude, loaded from claude, session 0b6c1e9a-7d3f-4c55-9a51-5c1f0e3a2b10: ${LOADED}`),
        said("2026-03-02T15:04:05.123Z"),
      ),
      write("notes/dock.md", `${NOTE}\n`),
    );
    firm.model.on(answered("write"), write("standing.md", `${STANDING}\n`));
    firm.model.on(answered("write"), say("Dreamed over the loaded history."));
    firm.model.on(all(main, said(ASK), said(STANDING), said(`notes/dock.md: ${NOTE}`)), say("Fridays at 9."));

    const printed = await firm.import("claude", join(EXPORTS, "claude-conversations.json"));
    expect(printed).toContain("loaded 6 messages in 2 sessions");
    await until(
      "the dream's end",
      () => firm.model.requests.filter(answered("write")).length === 2,
      60,
      firm.trouble,
    );
    await firm.person.send("desk", ASK);
    expect((await firm.person.next(60)).text).toBe("Fridays at 9.");

    // The nightly dream is one repeating timer, on the expression the setup gives (SPEC part 3).
    const setup = Bun.YAML.parse(readFileSync(join(firm.folder, "duck.yaml"), "utf8")) as Setup;
    using db = firm.db();
    const nightly = db
      .query<{ repeat: string }, []>(
        "select repeat from timers where note like '%dreaming.md%' and repeat is not null",
      )
      .all();
    expect(nightly).toEqual([{ repeat: setup.timers.dreaming }]);
  });

  test("an earlier Hermes agent's memory and schedules land in the coworker's home, where its dream is told to read them", async () => {
    const profile = mkdtempSync(join(tmpdir(), "hermes-"));
    cpSync(join(EXPORTS, "hermes-profile"), profile, { recursive: true });
    const store = new Database(join(profile, "state.db"));
    store.exec(readFileSync(join(EXPORTS, "hermes-state.sql"), "utf8"));
    store.close();
    const before = "/duck/home/before/hermes";
    firm.model.on(all(workLane, said("dreaming.md")), (r) =>
      call("shell", {
        command: `cat ${/\/\S+dreaming\.md/.exec(r.last)?.[0]} ${before}/memories/MEMORY.md ${before}/cron/jobs.json`,
      }),
    );
    firm.model.on(answered("shell"), say("Dreamed."));

    const printed = await firm.import("hermes", profile);
    expect(printed).toContain("loaded 7 messages in 2 sessions");
    expect(printed).toContain("copied cron/jobs.json, memories/MEMORY.md to ");
    await until("the dream", () => firm.model.requests.some(answered("shell")), 60, firm.trouble);
    const read = firm.model.requests.find(answered("shell"))?.last ?? "";
    expect(read).toContain("is in `before/` in your home");
    expect(read).toContain("The dock crew's inspection is Fridays at 9.");
    expect(read).toContain('"schedule_display": "0 7 * * 1"');
    expect(await firm.import("hermes", profile)).not.toContain("copied");
  });

  test("after a reboot: the unit duck install enabled brings the firm's containers back, and the coworker's clock is in its person's zone", async () => {
    const ASK = "What's your clock's offset from UTC?";
    /** `zone`'s offset from UTC now, as `date +%z` prints it. */
    const offset = (zone: string) =>
      new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
        .format(new Date())
        .replace(/.*GMT/, "")
        .replace(":", "");
    firm.model.on(said(ASK), call("shell", { command: "date +%z" }));
    firm.model.on(answered("shell"), (r) => say(`It is ${r.last.trim()}.`));
    expect(await firm.systemd("is-enabled")).toBe("enabled");

    await firm.stop();
    expect(await fetch(`${firm.address}/ready`).catch(() => null)).toBeNull();
    await firm.boot();
    await firm.person.send("desk", ASK);
    expect((await firm.person.next(60)).text).toContain(offset(harbor.zone));
  });

  test("the how-tos an earlier Hermes agent made or changed land in the coworker's home whole, for its dream to read; Hermes's stock catalog and retired how-tos stay behind", async () => {
    const profile = mkdtempSync(join(tmpdir(), "hermes-"));
    cpSync(join(EXPORTS, "hermes-profile"), profile, { recursive: true });
    const store = new Database(join(profile, "state.db"));
    store.exec(readFileSync(join(EXPORTS, "hermes-state.sql"), "utf8"));
    store.close();
    const write = (path: string, content: string) => Bun.write(join(profile, "skills", path), content);
    const skill = (dir: string, name: string, words: string) =>
      write(`${dir}/SKILL.md`, `---\nname: ${name}\ndescription: ${words}\n---\n\n${words}\n`);
    await skill("harbor/dock-inspection", "dock-inspection", "Walk the dock with the crew lead on Fridays at 9.");
    await write("harbor/dock-inspection/references/form.md", "Log each loose cleat with its berth number.\n");
    await skill("email/crew-notes", "short-crew-notes", "Notes to the dock crew are three lines at most.");
    await skill("weather/tide-tables", "tide-tables", "Read the tide tables.");
    await skill("harbor/old-roster", "old-roster", "Send the roster to the old office.");
    await write(
      ".usage.json",
      JSON.stringify({
        "dock-inspection": { created_by: "agent", patch_count: 0, state: "active" },
        "short-crew-notes": { created_by: null, patch_count: 2, state: "stale" },
        "tide-tables": { created_by: null, patch_count: 0, state: "active" },
        "old-roster": { created_by: "agent", patch_count: 1, state: "archived" },
      }),
    );
    const before = "/duck/home/before/hermes/skills";
    firm.model.on(all(workLane, said("dreaming.md")), (r) =>
      call("shell", {
        command: `cat ${/\/\S+dreaming\.md/.exec(r.last)?.[0]} ${before}/email/crew-notes/SKILL.md ${before}/harbor/dock-inspection/references/form.md; ls -R ${before}`,
      }),
    );
    firm.model.on(answered("shell"), say("Dreamed."));

    const printed = await firm.import("hermes", profile);
    expect(printed).toContain("copied skills/email/crew-notes, skills/harbor/dock-inspection to ");
    await until("the dream", () => firm.model.requests.some(answered("shell")), 60, firm.trouble);
    const read = firm.model.requests.find(answered("shell"))?.last ?? "";
    expect(read).toContain("A how-to names that product's tools, not yours");
    expect(read).toContain("Log each loose cleat with its berth number.");
    expect(read).toContain("Notes to the dock crew are three lines at most.");
    expect(read).not.toContain("tide-tables");
    expect(read).not.toContain("old-roster");
    expect(await firm.import("hermes", profile)).not.toContain("copied");
  });
});

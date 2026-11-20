import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answered, call, E2E, harbor, said, say, startFirm, TOOLS, until } from "../kit";

const SAID = "The gate code for 4B is 2468. And remind me to send Dana the rent roll.";
const NOTE = "The gate code for 4B is 2468. (Rosa, in chat.)";
const ITEM = "Send Dana the rent roll";
const ASK = "What's the gate code for 4B again?";

test(
  "backup and restore: the running duck copies every coworker at the setup's time into a repository of its own in the bucket, a copy stores only what changed since the last, and a coworker brought back from the bucket onto an empty server knows the conversation, its list and its notes, and has its files",
  async () => {
    await using firm = await startFirm({ backup: "* * * * *" });
    // A file the coworker keeps, which no copy after the first sends again.
    const plans = randomBytes(2_000_000);
    const kept = join(firm.folder, "storage", harbor.coworker, "home", "plans.bin");
    writeFileSync(kept, plans);
    firm.model.on(said(SAID), call("write", { path: "/duck/home/notes/gate.md", content: `${NOTE}\n` }));
    firm.model.on(answered("write"), call(TOOLS.writeItem, { title: ITEM }));
    firm.model.on(answered(TOOLS.writeItem), say("Noted, 2468 for 4B, and the rent roll is on your list."));
    firm.model.on(said(ASK), say("It's 2468."));

    await firm.person.send("desk", SAID);
    await firm.person.nextWith("Noted, 2468", 30);
    await until("the running duck's copy", () => firm.bucket.uploads.length > 0, 90, firm.trouble);
    // The minute's copy may have come before the conversation, so the copy restored is the one made now.
    expect(await firm.backup()).toContain(harbor.coworker);
    const before = firm.bucket.received();
    await firm.backup();
    expect(firm.bucket.received() - before).toBeLessThan(plans.length / 2);
    for (const key of firm.bucket.objects.keys())
      expect(key.startsWith(`restic/${firm.name}/${harbor.coworker}/`)).toBe(true);

    await firm.wipe();
    expect(readdirSync(join(firm.folder, "storage"))).toEqual([]);
    await firm.restore();
    expect(readFileSync(kept).equals(plans)).toBe(true);
    await firm.start();
    await firm.person.send("desk", ASK);
    await firm.person.nextWith("It's 2468.", 60);

    const asked = firm.model.requests.findLast(said(ASK));
    expect(asked?.shows(SAID)).toBe(true);
    for (const shown of [ITEM, `notes/gate.md: ${NOTE}`]) expect(asked?.last).toContain(shown);
    await expect(firm.restore()).rejects.toThrow("already holds a database");
  },
  E2E,
);

test(
  "backup keeps duck's hold on the database: a program that opens and closes it after the running duck's copy leaves its write-ahead log, and the coworker answers",
  async () => {
    await using firm = await startFirm({ backup: "* * * * *" });
    await until("the running duck's copy", () => firm.bucket.uploads.length > 0, 90, firm.trouble);
    // The last connection to close a database in WAL mode checkpoints it and deletes its -wal; while duck
    // holds its locks, another program's connection is never the last.
    const db = join(firm.folder, "storage", harbor.coworker, "duck.db");
    const other = new Database(db);
    other.query("select count(*) from sqlite_master").get();
    other.close();
    expect(await Bun.file(`${db}-wal`).exists()).toBe(true);
    firm.model.on(said(ASK), say("It's 2468."));
    await firm.person.send("desk", ASK);
    await firm.person.nextWith("It's 2468.", 60);
  },
  E2E,
);

import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/inbox";
import { tick, useTimers } from "../../src/timers";
import { random } from "./random";

const ZONE = "America/Chicago";
const REPEATS = [undefined, undefined, "*/20 * * * *", "0 8 * * MON", "@hourly"];
const MINUTE = 60_000;

// Each restart opens the database file again, which takes far longer than a step in memory: hence 30 s.
test("timers: any sequence of set, remove, tick, crash and restart fires each due timer exactly once, on its item", () => {
  const folder = mkdtempSync(join(tmpdir(), "timers-"));
  for (let seed = 1; seed <= 100; seed++) {
    const next = random(seed);
    const pick = <T>(of: T[]) => of[Math.floor(next() * of.length)] as T;
    const path = join(folder, `${seed}.db`);
    let db: Database = openDb(path);
    // US daylight saving time ends on 2026-11-01, inside the days this runs across.
    let now = Date.parse("2026-10-30T00:00:00Z") + Math.floor(next() * 86_400_000);
    /** What each timer should be: when it is next due (null once done), its repeat and its item. */
    const want = new Map<number, { at: string | null; repeat?: string; item: number | null }>();
    /** The firings that should be in the inbox, by ref, each with its item. */
    const fired = new Map<string, number | null>();
    const due = () => [...want].filter(([, t]) => t.at !== null && Date.parse(t.at) <= now);
    for (let step = 0; step < 60; step++) {
      const roll = next();
      if (roll < 0.35) {
        const at = new Date(now + Math.floor((next() * 300 - 60) * MINUTE)).toISOString();
        const repeat = pick(REPEATS);
        const item = next() < 0.5 ? null : Math.floor(next() * 5) + 1;
        const words = useTimers(db, ZONE, "set_timer", {
          at,
          note: `note ${step}`,
          ...(repeat ? { repeat } : {}),
          ...(item ? { item_id: item } : {}),
        });
        want.set(Number(/Timer (\d+)/.exec(words)?.[1]), { at, repeat, item });
      } else if (roll < 0.45 && want.size > 0) {
        const id = pick([...want.keys()]);
        useTimers(db, ZONE, "remove_timer", { id });
        want.delete(id);
      } else if (roll < 0.85) {
        now += Math.floor(next() * 180 * MINUTE);
        tick(db, ZONE, now);
        for (const [id, t] of due()) {
          fired.set(`${id}@${t.at}`, t.item);
          t.at = t.repeat ? (Bun.cron.parse(t.repeat, now, { tz: ZONE })?.toISOString() ?? null) : null;
        }
      } else {
        // A crash between the first due timer's inbox row and its timer's update, then a restart.
        now += Math.floor(next() * 180 * MINUTE);
        db.exec("create temp trigger crash before update on timers begin select raise(abort, 'crash'); end");
        const [first] = due();
        if (first) {
          expect(() => tick(db, ZONE, now)).toThrow("crash");
          fired.set(`${first[0]}@${first[1].at}`, first[1].item);
        }
        db.close();
        db = openDb(path);
      }
      if (next() < 0.1) {
        db.close();
        db = openDb(path);
      }
      const rows = db
        .query<{ ref: string; item_id: number | null }, []>(
          "select ref, item_id from inbox where source = 'timer' order by ref",
        )
        .all();
      expect(rows, `seed ${seed}, step ${step}`).toEqual(
        [...fired].sort(([a], [b]) => (a < b ? -1 : 1)).map(([ref, item_id]) => ({ ref, item_id })),
      );
    }
    db.close();
  }
}, 30_000);

import { expect, test } from "bun:test";
import { openDb } from "../../src/inbox";
import { due, settle, tell } from "../../src/outbox";
import { random } from "./random";

/** A person three hours east of UTC, quiet from 21:00 to 07:00 there, who hears at most once in 20 minutes. */
const PERSON = {
  name: "Rosa Alvarez",
  zone: "Etc/GMT-3",
  quiet: ["21:00", "07:00"] as [string, string],
  one_message_per: "20m",
};
const LIMIT = 20 * 60_000;
const quiet = (at: number) => {
  const hour = (new Date(at).getUTCHours() + 3) % 24;
  return hour >= 21 || hour < 7;
};

type Stored = { id: number; urgent: number; state: string; sent_at: string | null; door: string | null };

test("outbox states: a row leaves pending once, for sent or dropped; urgent rows go at once, the rest outside quiet hours and within the limit", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const next = random(seed);
    const db = openDb(":memory:");
    let now = Date.parse("2026-11-20T00:00:00Z") + Math.floor(next() * 86_400_000);
    const left = new Map<number, Stored>();
    /** When each message that carried a non-urgent row went. */
    const told: number[] = [];
    for (let step = 0; step < 80; step++) {
      const roll = next();
      if (roll < 0.4) tell(db, { text: `row ${step}`, urgent: next() < 0.2 });
      else if (roll < 0.7) now += Math.floor(next() * 90 * 60_000);
      else {
        const { rows } = due(db, PERSON, now);
        const pending = db.query<Stored, []>("select * from outbox where state = 'pending'").all();
        for (const p of pending) {
          const may = p.urgent === 1 || (!quiet(now) && told.every((t) => now - t >= LIMIT));
          expect(
            rows.some((r) => r.id === p.id),
            `seed ${seed}: row ${p.id} at ${now}`,
          ).toBe(may);
        }
        expect(rows.every((r) => pending.some((p) => p.id === r.id))).toBe(true);
        const door = next() < 0.9 ? "desk" : null;
        settle(
          db,
          rows.map((r) => r.id),
          door,
          now,
        );
        if (door && rows.some((r) => !r.urgent)) told.push(now);
      }
      for (const row of db.query<Stored, []>("select * from outbox where state != 'pending'").all()) {
        const was = left.get(row.id);
        if (was) expect(row, `seed ${seed}: row ${row.id} changed after it left pending`).toEqual(was);
        else left.set(row.id, row);
        const sent = row.state === "sent";
        expect([row.door !== null, row.sent_at !== null], `seed ${seed}: row ${row.id}`).toEqual([
          sent,
          sent,
        ]);
      }
    }
    db.close();
  }
});

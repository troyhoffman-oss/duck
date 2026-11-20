import { expect, test } from "bun:test";
import { add, openDb } from "../../src/inbox";
import { random } from "./random";

test("inbox deduplication: one row per source and ref, however often and in whatever order events arrive", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed);
    const pick = <T>(of: T[]) => of[Math.floor(next() * of.length)] as T;
    const db = openDb(":memory:");
    const first = new Map<string, number>();
    for (let i = Math.floor(next() * 60); i > 0; i--) {
      const [source, ref] = [pick(["desk", "phone", "mail"]), pick(["1", "2", "3", "m-7", "m-8"])];
      const id = add(db, source, ref);
      const key = JSON.stringify([source, ref]);
      if (first.has(key)) expect(id, `seed ${seed}: ${key} written twice`).toBeNull();
      else {
        expect(id, `seed ${seed}: ${key} not written`).not.toBeNull();
        first.set(key, id as number);
      }
    }
    const rows = db
      .query<{ id: number; source: string; ref: string }, []>("select id, source, ref from inbox order by id")
      .all();
    expect(rows.map((r) => [JSON.stringify([r.source, r.ref]), r.id])).toEqual([...first]);
    db.close();
  }
});

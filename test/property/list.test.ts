import { expect, test } from "bun:test";
import { openDb } from "../../src/inbox";
import { openItems, useList, writeItem } from "../../src/list";
import { random } from "./random";

const STATES = ["open", "waiting", "done", "dropped"];
const OPEN = ["open", "waiting"];

test("item states: an item is always open, waiting, done or dropped, as last written, and only open ones load", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed);
    const pick = <T>(of: T[]) => of[Math.floor(next() * of.length)] as T;
    const db = openDb(":memory:");
    // What each item should be: its title, a word only its title holds, its state and when it was made.
    const want = new Map<number, { title: string; word: string; state: string; created: string }>();
    let words = 0;
    for (let i = Math.floor(next() * 40); i > 0; i--) {
      const word = `w${++words}x`;
      const title = `Item ${word} for ${pick(["Dana", "Rosa", "the rent roll"])}`;
      const state = pick([...STATES, "closed", "OPEN", ""]);
      const known = [...want.keys()];
      const id = known.length > 0 && next() < 0.6 ? pick(known) : undefined;
      const input = {
        ...(id === undefined ? {} : { id }),
        ...(id === undefined || next() < 0.5 ? { title } : {}),
        ...(next() < 0.7 ? { state } : {}),
        ...(next() < 0.5 ? { next: pick(["Call Dana", "Wait for the roll", null]) } : {}),
        links: next() < 0.3 ? [{ kind: "mail_thread", ref: `<m-${i}@harbor.example>` }] : [],
      };
      const before = id === undefined ? undefined : db.query("select * from items where id = ?").get(id);
      const links = (db.query("select count(*) n from links").get() as { n: number }).n;
      if ("state" in input && !STATES.includes(input.state as string)) {
        expect(() => writeItem(db, input), `seed ${seed}: state "${state}" taken`).toThrow();
        if (id !== undefined) expect(db.query("select * from items where id = ?").get(id)).toEqual(before);
        expect((db.query("select count(*) n from links").get() as { n: number }).n).toBe(links);
        continue;
      }
      const written = writeItem(db, input);
      const was = want.get(written);
      want.set(written, {
        title: "title" in input ? title : (was?.title as string),
        word: "title" in input ? word : (was?.word as string),
        state: "state" in input ? state : (was?.state ?? "open"),
        created:
          was?.created ??
          (db.query("select created_at c from items where id = ?").get(written) as { c: string }).c,
      });
      if (was && "title" in input)
        expect(useList(db, "read_list", { query: was.word }), `seed ${seed}: old title still found`).toBe(
          "No item matches.",
        );
    }
    expect(() => writeItem(db, { id: 10_000, state: "done" }), `seed ${seed}`).toThrow(
      "there is no item 10000",
    );

    const rows = db
      .query<{ id: number; title: string; state: string; created_at: string }, []>(
        "select * from items order by id",
      )
      .all();
    expect(
      rows.map((r) => [r.id, r.title, r.state, r.created_at]),
      `seed ${seed}`,
    ).toEqual([...want].sort(([a], [b]) => a - b).map(([id, w]) => [id, w.title, w.state, w.created]));
    expect(
      openItems(db).map((l) => Number(l.split(".")[0])),
      `seed ${seed}: the open lines`,
    ).toEqual(rows.filter((r) => OPEN.includes(r.state)).map((r) => r.id));
    for (const [id, w] of want)
      expect(
        useList(db, "read_list", { query: w.word }),
        `seed ${seed}: item ${id} by its title`,
      ).toStartWith(`${id}. ${w.title} · ${w.state}`);
    db.close();
  }
});

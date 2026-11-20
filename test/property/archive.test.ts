import { expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heard, readArchive, told } from "../../src/archive";
import { importHistory } from "../../src/archive/history";
import { openDb } from "../../src/inbox";
import { random } from "./random";

/** The time at the start of each line the archive's tool shows. */
const times = (shown: string) => [...shown.matchAll(/^- (\S+),/gm)].map((m) => m[1] as string);

test("archive search: every message written or imported is found by a word in it, once, and searches come back in time order", () => {
  const folder = mkdtempSync(join(tmpdir(), "archive-"));
  try {
    for (let seed = 1; seed <= 100; seed++) {
      const next = random(seed);
      // A time between 2020 and 2026, in no order.
      const when = () => new Date(Date.UTC(2020, 0) + Math.floor(next() * 6 * 365 * 86_400_000));
      const db = openDb(":memory:");
      /** Each message's text, a word only it holds, by the time it was written. */
      const want = new Map<string, string>();
      let words = 0;
      for (let i = Math.floor(next() * 80); i > 0; i--) {
        const kind = Math.floor(next() * 3);
        const batch = kind === 2 ? 1 + Math.floor(next() * 4) : 1;
        const written = Array.from({ length: batch }, () => ({
          at: when(),
          text: `About the harbor, w${++words}x.`,
        }));
        if (kind === 2) {
          // A Claude export of one-message conversations, each loaded as it is.
          const path = join(folder, `${seed}-${i}.json`);
          const conversations = written.map((m, n) => ({
            uuid: `c-${seed}-${i}-${n}`,
            chat_messages: [
              {
                uuid: `m-${seed}-${i}-${n}`,
                parent_message_uuid: "",
                sender: next() < 0.5 ? "human" : "assistant",
                created_at: m.at.toISOString(),
                content: [{ type: "text", text: m.text }],
                attachments: [],
                files: [],
              },
            ],
          }));
          writeFileSync(path, JSON.stringify(conversations));
          importHistory(db, "claude", path);
        } else {
          const m = written[0] as { at: Date; text: string };
          setSystemTime(m.at);
          if (kind === 0) heard(db, "desk", i, m.text, []);
          else told(db, "phone", "s-1", m.text, []);
        }
        for (const m of written) want.set(m.at.toISOString(), m.text);
      }
      setSystemTime();

      for (const text of want.values()) {
        const word = /w\d+x/.exec(text)?.[0] as string;
        const found = readArchive(db, "Rosa", { query: word }).split("\n");
        expect(found).toHaveLength(1);
        expect(found[0]).toEndWith(`: ${text}`);
      }

      // Every message holds "harbor": read them all, a page at a time, each page starting at the last shown.
      const shown: string[] = [];
      for (let from: string | undefined; ; ) {
        const page = readArchive(db, "Rosa", { query: "harbor", ...(from ? { from } : {}) });
        if (page === "No message matches.") break;
        const lines = page.split("\n");
        expect(times(page)).toEqual(times(page).toSorted());
        shown.push(...lines.filter((l) => !shown.includes(l)));
        if (lines.length < 30) break;
        from = times(page).at(-1);
      }
      const order = [...want.keys()].sort();
      expect(times(shown.join("\n"))).toEqual(order);
      expect(shown.map((l) => l.slice(l.lastIndexOf(": ") + 2))).toEqual(
        order.map((at) => want.get(at) as string),
      );
    }
  } finally {
    setSystemTime();
  }
});

test("archive reading back: stepping `to` back to the first time shown reads every message, until a read comes back short, and a cut message is read whole by its id", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const next = random(seed);
    const db = openDb(":memory:");
    /** Each message's text by the time it was written, some longer than a line shows. */
    const want = new Map<string, string>();
    for (let i = Math.floor(next() * 100); i > 0; i--) {
      const at = new Date(Date.UTC(2020, 0) + Math.floor(next() * 6 * 365 * 86_400_000));
      const text = `About the harbor, w${i}x.${next() < 0.3 ? " and the dock".repeat(Math.floor(next() * 200)) : ""}`;
      setSystemTime(at);
      heard(db, "desk", i, text, []);
      want.set(at.toISOString(), text);
    }
    setSystemTime();

    const shown = new Map<string, string>();
    for (let to = new Date().toISOString(); ; ) {
      const page = readArchive(db, "Rosa", { to });
      if (page === "No message matches.") break;
      const lines = page.split("\n");
      expect(times(page)).toEqual(times(page).toSorted());
      for (const l of lines) shown.set(times(l)[0] as string, l);
      if (lines.length < 30) break;
      to = times(page)[0] as string;
    }
    expect([...shown.keys()].sort()).toEqual([...want.keys()].sort());
    for (const [at, line] of shown) {
      const text = want.get(at) as string;
      if (text.length <= 1000) {
        expect(line).toEndWith(`: ${text}`);
        continue;
      }
      const id = /read it whole with message (\d+)\)$/.exec(line)?.[1];
      expect(line).toEndWith(`: ${text.slice(0, 1000)}… (cut from ${text.length} characters; read it whole with message ${id})`);
      expect(readArchive(db, "Rosa", { message: Number(id) })).toEndWith(`: ${text}`);
    }
  }
});

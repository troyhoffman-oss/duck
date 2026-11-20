import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  all,
  answered,
  type Buzz,
  call,
  coworkerRun,
  E2E,
  type Firm,
  idIn,
  loadPlugin,
  say,
  shows,
  sorter,
  startBuzz,
  startFirm,
  TOOLS,
} from "../kit";

const ASKED = {
  ref: "<terms-4b@harbor.example>",
  payload: {
    from: "Dana Reyes <dana.reyes@harbor.example>",
    subject: "Renewal terms for 4B",
    text: "Hi Rosa, what are the terms?",
  },
};
const SIGNED = {
  ref: "<signed-4b@harbor.example>",
  payload: {
    from: "Dana Reyes <dana.reyes@harbor.example>",
    subject: "4B renewal signed",
    text: "Signed and sent back.",
  },
};
const ITEM = {
  title: "Send Dana the 4B renewal terms",
  holder: "Rosa",
  next: "Approve the $1,900 rent",
  due: "2026-11-27",
};

// The To-dos tab (SPEC part 11, The plugin): duck's own plugin code reads, as Rosa's desktop would, the list duck
// publishes for her coworker in her channel with duck. One relay and one firm for every step, which run in order.
describe("a person reads their coworker's list in the To-dos tab, and nobody else can", () => {
  let buzz: Buzz;
  let firm: Firm;
  let plugin: Awaited<ReturnType<typeof loadPlugin>>;
  let item = 0;
  beforeAll(async () => {
    buzz = await startBuzz();
    firm = await startFirm({ buzz });
    plugin = await loadPlugin(buzz, "rosa");
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
    await buzz?.[Symbol.asyncDispose]();
  }, E2E);

  test(
    "a mail that becomes an item the person holds shows in their To-dos under Needs you, and another member reads none of it",
    async () => {
      const empty = await plugin.tab("To-dos", buzz.keys.wren, (l) => l[0] === "Nothing is on its list yet.");
      expect(empty.lines).toEqual(["Nothing is on its list yet."]);
      firm.model.on(all(sorter, shows(ASKED.payload.subject)), say("wake: a tenant asks for her terms"));
      firm.model.on(all(coworkerRun, shows(ASKED.payload.subject)), call(TOOLS.writeItem, ITEM));
      firm.model.on(answered(TOOLS.writeItem), (r) => {
        item = idIn(r.last);
        return say("Dana asked for the 4B terms; they wait on your approval.");
      });
      await firm.push(ASKED);
      const shown = await plugin.tab("To-dos", buzz.keys.wren, (l) => l.includes(ITEM.title));
      expect(shown.lines).toEqual(["Needs you", ITEM.title, `${ITEM.next} · due ${ITEM.due}`]);

      const channel = (await buzz.channelWith("rosa", firm.duckKey as string)) as string;
      const [list] = await buzz.query("rosa", [
        { artifact: "current", "#h": [channel], "#type": ["duck.list"] },
      ]);
      expect(list?.pubkey).toBe(firm.duckKey as string);
      expect(list?.tags).toContainEqual(["agent", buzz.keys.wren]);
      expect(JSON.parse(list?.content as string)).toEqual({
        version: 1,
        items: [{ group: "you", id: item, state: "open", ...ITEM, updated_at: expect.any(String) }],
      });
      const d = list?.tags.find((t) => t[0] === "d")?.[1] as string;
      expect(await buzz.query("rosa", [{ ids: [list?.id] }])).toHaveLength(1);
      expect(await buzz.query("theo", [{ ids: [list?.id] }])).toEqual([]);
      expect(await buzz.query("theo", [{ kinds: [45010], "#d": [d] }])).toEqual([]);
      await expect(buzz.query("theo", [{ kinds: [45010], "#h": [channel] }])).rejects.toThrow("restricted");
    },
    E2E,
  );

  test(
    "an item the coworker closes moves to Done this week, folded away",
    async () => {
      firm.model.on(all(sorter, shows(SIGNED.payload.subject)), say("wake: the renewal is signed"));
      firm.model.on(all(coworkerRun, shows(SIGNED.payload.subject)), () =>
        call(TOOLS.writeItem, { id: item, state: "done", log: "Dana signed the renewal." }),
      );
      firm.model.on(answered(TOOLS.writeItem), say("Dana signed the 4B renewal."));
      await firm.push(SIGNED);
      const shown = await plugin.tab("To-dos", buzz.keys.wren, (l) => l[0] === "Done this week");
      expect(shown.lines).toEqual(["Done this week", ITEM.title, `${ITEM.next} · due ${ITEM.due}`]);
      expect(shown.folded).toEqual(shown.lines);
    },
    E2E,
  );
});

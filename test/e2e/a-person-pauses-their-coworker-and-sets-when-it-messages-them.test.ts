import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  all,
  answered,
  type Buzz,
  call,
  coworkerRun,
  E2E,
  type Firm,
  harbor,
  loadPlugin,
  said,
  say,
  shows,
  sorter,
  startBuzz,
  startFirm,
  TOOLS,
  until,
} from "../kit";

const PAID = {
  ref: "<paid-2a@harbor.example>",
  payload: {
    from: "Lee Park <lee.park@harbor.example>",
    subject: "2A rent paid",
    text: "November's rent is paid.",
  },
};
const NOTE = "2A paid November's rent.";
const TOLD = "Lee paid 2A's November rent.";
const [HELLO, REPLY] = ["Anything new on 4B?", "Nothing new on 4B since yesterday."];
const LOCKED = "Your firm sets that for every coworker, so nothing changed.";
const COST = "Model use this month at list price: $";

// A person's own settings (SPEC part 1, Settings) through duck's plugin, driven as Rosa's desktop drives it,
// against a real relay and a real firm. One relay and one firm for every step, which run in order.
describe("a person pauses their coworker and sets when it messages them", () => {
  let buzz: Buzz;
  let firm: Firm;
  let plugin: Awaited<ReturnType<typeof loadPlugin>>;
  beforeAll(async () => {
    buzz = await startBuzz();
    firm = await startFirm({ buzz });
    plugin = await loadPlugin(buzz, "rosa");
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
    await buzz?.[Symbol.asyncDispose]();
  }, E2E);
  const preferences = (fits: (shown: string[]) => boolean) => plugin.tab("Preferences", buzz.keys.wren, fits);
  /** Where the mail plug's event stands in the inbox: pending, running or done, or null before it came. */
  const event = () => {
    using db = firm.db();
    return db.query<{ state: string }, [string]>("select state from inbox where ref = ?").get(PAID.ref)
      ?.state;
  };

  test(
    "while paused an event starts no run and its person's own message is answered, and on resume it catches up and tells them once",
    async () => {
      const firmWide = await preferences((l) => l.includes("When it messages you"));
      expect(firmWide.controls.Paused).toMatchObject({ checked: false, disabled: false });
      expect(firmWide.controls["Quiet hours"]).toMatchObject({ checked: true, disabled: false });
      expect(firmWide.controls["Messages an hour"]).toMatchObject({ defaultValue: 1, disabled: false });
      expect((await firmWide.change("Paused", { checked: true })).lines).not.toContain(LOCKED);
      const paused = await preferences(() => true);
      expect(paused.controls.Paused?.checked).toBe(true);

      firm.model.on(all(sorter, shows(PAID.payload.subject)), say("wake: a rent payment"));
      firm.model.on(all(coworkerRun, said(PAID.payload.text)), call(TOOLS.tell, { text: NOTE }));
      firm.model.on(answered(TOOLS.tell), say("Told."));
      firm.model.on(all(coworkerRun, said(NOTE)), say(TOLD));
      firm.model.on(all(coworkerRun, said(HELLO)), say(REPLY));
      await firm.push(PAID);
      await until("the event in the inbox", () => event() === "pending", 60, firm.trouble);
      // The sorter's gap and the scheduler are a second each here, so a coworker at work would have taken it.
      await firm.person.quiet(10);
      expect(firm.model.requests.filter(shows(PAID.payload.subject))).toEqual([]);
      await firm.person.send("desk", HELLO);
      expect((await firm.person.next(120)).text).toBe(REPLY);
      expect(firm.model.requests.filter(all(said(HELLO), said("has paused you")))).not.toEqual([]);
      expect(firm.model.requests.filter(shows(PAID.payload.subject))).toEqual([]);
      expect(event()).toBe("pending");

      await paused.change("Paused", { checked: false });
      expect((await firm.person.next(120)).text).toBe(TOLD);
      await firm.person.quiet(15);
      const caught = firm.model.requests.filter(all(coworkerRun, said(PAID.payload.text)));
      expect(caught.map((r) => r.last.includes("paused you from"))).toEqual([true]);
      expect(event()).toBe("done");
      expect((await preferences((l) => l.some((t) => t.startsWith(COST)))).lines).toContainEqual(
        expect.stringMatching(/^Model use this month at list price: \$\d+\.\d\d$/),
      );
    },
    E2E,
  );

  test(
    "its person turns quiet hours off, and a setting the firm locks is refused in fixed words and changes nothing",
    async () => {
      const shown = await preferences((l) => l.includes("When it messages you"));
      await shown.change("Quiet hours", { checked: false });
      expect((await preferences(() => true)).controls["Quiet hours"]?.checked).toBe(false);
      await shown.change("Messages an hour", { value: "53" });
      expect((await preferences(() => true)).controls["Messages an hour"]?.defaultValue).toBe(53);

      await firm.reinstall((setup) => {
        (setup.settings as { locked?: string[] }).locked = ["one_message_per"];
      });
      const locked = await preferences((l) => l.includes("Set by your firm"));
      expect(locked.controls["Messages an hour"]).toMatchObject({ defaultValue: 1, disabled: true });
      expect((await locked.change("Messages an hour", { value: "6" })).lines).toContain(LOCKED);
      const file = join(firm.folder, "storage", harbor.coworker, "settings.json");
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        paused: false,
        quiet: null,
        one_message_per: "68s",
      });
      expect((await preferences(() => true)).controls["Messages an hour"]?.defaultValue).toBe(1);
    },
    E2E,
  );

  test(
    "another member reads nothing of a person's preferences",
    async () => {
      const dm = await buzz.dmWith("rosa", firm.duckKey as string);
      const [prefs] = await buzz.query("rosa", [
        { artifact: "current", "#h": [dm], "#type": ["duck.person"] },
      ]);
      expect(JSON.parse(prefs?.content as string)).toEqual({
        version: 1,
        coworker: harbor.coworker,
        paused: { value: false, locked: false },
        quiet: { value: null, locked: false },
        messages_per_hour: { value: 1, locked: true },
        cost: expect.any(Number),
      });
      expect(JSON.parse(prefs?.content as string).cost).toBeGreaterThan(0);
      const d = prefs?.tags.find((t) => t[0] === "d")?.[1] as string;
      expect(await buzz.query("rosa", [{ ids: [prefs?.id] }])).toHaveLength(1);
      expect(await buzz.query("theo", [{ ids: [prefs?.id] }])).toEqual([]);
      expect(await buzz.query("theo", [{ kinds: [45010], "#d": [d] }])).toEqual([]);
    },
    E2E,
  );
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  all,
  answered,
  type Buzz,
  call,
  clock,
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
/** Rosa's own time zone, hours from the firm's at every time of year. */
const ZONE = "Asia/Tokyo";

/** `zone`'s offset from UTC now, as goose's turn-context block writes it, such as +09:00. */
const offsetIn = (zone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .format(new Date())
    .replace(/.*GMT/, "") || "+00:00";

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

  test.failing(
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

  test.failing(
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

  test.failing(
    "another member reads nothing of a person's preferences",
    async () => {
      const channel = (await buzz.channelWith("rosa", firm.duckKey as string)) as string;
      const [prefs] = await buzz.query("rosa", [
        { artifact: "current", "#h": [channel], "#type": ["duck.person"] },
      ]);
      const { zone } = Bun.YAML.parse(readFileSync(join(firm.folder, "duck.yaml"), "utf8")) as {
        zone: string;
      };
      expect(JSON.parse(prefs?.content as string)).toEqual({
        version: 1,
        coworker: harbor.coworker,
        paused: { value: false, locked: false },
        quiet: { value: null, locked: false },
        messages_per_hour: { value: 1, locked: true },
        zone: { value: zone, locked: false },
        cost: expect.any(Number),
      });
      expect(JSON.parse(prefs?.content as string).cost).toBeGreaterThan(0);
      const d = prefs?.tags.find((t) => t[0] === "d")?.[1] as string;
      // A system channel is read only by naming it (buzz-relay src/handlers/system_channels.rs:1-23).
      expect(await buzz.query("rosa", [{ ids: [prefs?.id], "#h": [channel] }])).toHaveLength(1);
      expect(await buzz.query("theo", [{ ids: [prefs?.id] }])).toEqual([]);
      expect(await buzz.query("theo", [{ kinds: [45010], "#d": [d] }])).toEqual([]);
      await expect(buzz.query("theo", [{ kinds: [45010], "#h": [channel] }])).rejects.toThrow("restricted");
    },
    E2E,
  );

  test.failing(
    "its person sets their own time zone in the Preferences tab, and one that is not a zone is refused saying so; the coworker's clock, the time the model sees and a repeating timer then go by theirs",
    async () => {
      const file = join(firm.folder, "storage", harbor.coworker, "settings.json");
      const shown = await preferences((l) => l.includes("When it messages you"));
      expect((await shown.change("Time zone", { value: "Mars/Olympus" })).lines).toContain(
        '"Mars/Olympus" is not a time zone; write one such as America/Chicago, so nothing changed.',
      );
      expect(JSON.parse(readFileSync(file, "utf8")).zone).toBeUndefined();
      const before = await firm.claimInstall();
      const changed = await (await preferences(() => true)).change("Time zone", { value: ZONE });
      expect(changed.lines.filter((l) => l.endsWith("so nothing changed."))).toEqual([]);
      expect(JSON.parse(readFileSync(file, "utf8")).zone).toBe(ZONE);
      expect((await preferences(() => true)).controls["Time zone"]?.defaultValue).toBe(ZONE);
      // Dreaming's repeating timer moved to its next time in Rosa's zone (SPEC part 3).
      const { timers } = Bun.YAML.parse(readFileSync(join(firm.folder, "duck.yaml"), "utf8")) as {
        timers: { dreaming: string };
      };
      {
        using db = firm.db();
        const dream = db
          .query<{ at: string }, []>(
            "select at from timers where note like '%dreaming.md%' and repeat is not null",
          )
          .get();
        expect(dream?.at).toBe(Bun.cron.parse(timers.dreaming, Date.now(), { tz: ZONE })?.toISOString());
      }
      // The change has the host run duck install, as a claim in duck's DM does; the step waits for it to end.
      const end = Date.now() + 240_000;
      for (let now = before; now.run === before.run || now.state !== "inactive"; await Bun.sleep(250)) {
        now = await firm.claimInstall();
        if (Date.now() > end) throw new Error(`duck's install after the new zone is ${now.state}, not done`);
      }

      const CLOCK = "What's your clock's offset from UTC?";
      firm.model.on(said(CLOCK), call("shell", { command: "date +%z" }));
      firm.model.on(answered("shell"), (r) => say(`It is ${r.last.trim()}.`));
      await firm.person.send("desk", CLOCK);
      expect((await firm.person.next(120)).text).toContain(offsetIn(ZONE).replace(":", ""));
      // goose's block at the run's start is from the coworker's clock; the relay's, on the call after, is duck's.
      const asked = firm.model.requests.find(said(CLOCK));
      expect(asked?.shown).toContain(`${offsetIn(ZONE)}</current-time>`);
      expect(asked?.shown).toContain(`time zone is ${ZONE}.`);
      const after = firm.model.requests.find(answered("shell"));
      expect(JSON.stringify(after?.messages.at(-1)?.content)).toContain(`${offsetIn(ZONE)}</current-time>`);

      // Every day at a time two minutes on in Rosa's zone, which in the firm's is hours away.
      const NOTE = "Remind Rosa to water the lobby plants.";
      const REMINDER = "Time to water the lobby plants.";
      const REMINDED = "Reminder: water the lobby plants.";
      firm.model.on(said("Remind me every day"), () => {
        const [hour, minute] = clock(ZONE, 2 / 60)
          .split(":")
          .map(Number);
        return call(TOOLS.setTimer, { note: NOTE, repeat: `${minute} ${hour} * * *` });
      });
      firm.model.on(answered(TOOLS.setTimer), say("I'll remind you."));
      firm.model.on(all(coworkerRun, said(NOTE)), call(TOOLS.tell, { text: REMINDER, urgent: true }));
      firm.model.on(answered(TOOLS.tell), say("Told."));
      firm.model.on(all(coworkerRun, said(REMINDER)), say(REMINDED));
      await firm.person.send("desk", "Remind me every day to water the lobby plants, from two minutes on.");
      expect((await firm.person.next(60)).text).toBe("I'll remind you.");
      expect((await firm.person.next(200)).text).toBe(REMINDED);
    },
    2 * E2E,
  );

  test.failing(
    "its quiet hours fall in its person's own night, in their zone",
    async () => {
      const LATE = {
        ref: "<late-3c@harbor.example>",
        payload: {
          from: "Lee Park <lee.park@harbor.example>",
          subject: "3C rent late",
          text: "3C's rent is late.",
        },
      };
      const [NOTED, NIGHT] = ["3C's November rent is late.", "3C hasn't paid November's rent yet."];
      await firm.reinstall((setup) => {
        delete (setup.settings as { locked?: string[] }).locked;
      });
      // Rosa's own limit, 68 s, holds again; the step waits it out, so only quiet hours can hold what follows.
      const lastSent = () => {
        using db = firm.db();
        return db
          .query<{ at: string | null }, []>(
            "select max(sent_at) as at from outbox where state = 'sent' and kind = 'tell' and not urgent",
          )
          .get()?.at;
      };
      await Bun.sleep(Math.max(0, Date.parse(lastSent() ?? "1970-01-01T00:00:00Z") + 69_000 - Date.now()));
      // Quiet from a minute ago to two minutes on in Rosa's zone, hours from any quiet time in the firm's: quiet
      // hours on, then their start, then their end, each a change in the Preferences tab.
      const quiet = [clock(ZONE, -1 / 60), clock(ZONE, 2 / 60)];
      await (await preferences(() => true)).change("Quiet hours", { checked: true });
      await (await preferences(() => true)).change("Quiet from", { value: quiet[0] });
      await (await preferences(() => true)).change("Quiet until", { value: quiet[1] });
      const file = join(firm.folder, "storage", harbor.coworker, "settings.json");
      expect(JSON.parse(readFileSync(file, "utf8")).quiet).toEqual(quiet);

      firm.model.on(all(sorter, shows(LATE.payload.subject)), say("wake: a late rent"));
      firm.model.on(all(coworkerRun, said(LATE.payload.text)), call(TOOLS.tell, { text: NOTED }));
      firm.model.on(answered(TOOLS.tell), say("Told."));
      firm.model.on(all(coworkerRun, said(NOTED)), say(NIGHT));
      await firm.push(LATE);
      const told = () => {
        using db = firm.db();
        return db.query("select 1 from outbox where text = ?").get(NOTED) !== null;
      };
      await until("the tell in the outbox", told, 60, firm.trouble);
      // Its quiet hours last at least a minute from when she set them.
      await firm.person.quiet(30);
      expect((await firm.person.next(200)).text).toBe(NIGHT);
    },
    2 * E2E,
  );
});

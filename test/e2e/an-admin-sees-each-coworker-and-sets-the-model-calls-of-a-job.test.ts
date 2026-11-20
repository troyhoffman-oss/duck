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
  idIn,
  JOB_CALLS,
  jobRun,
  loadPlugin,
  said,
  say,
  shows,
  startBuzz,
  startFirm,
  TOOLS,
} from "../kit";

const NOT_ADMIN = "Only an owner or admin of this community sets that, so nothing changed.";
const [ASK, BRIEF] = [
  "Find every mail about the boiler.",
  "List every mail about the boiler. Done means: each is listed.",
];
const CAPPED = "The boiler mail search hit its limit before it finished; nothing it found is verified.";

// What an admin sees of the firm's coworkers and the one job limit they set (SPEC parts 1 and 6), through duck's
// plugin as Buzz's Settings draws it, against a real relay and a real firm. Rosa owns the community; Theo is a
// member. One relay and one firm for every step, which run in order.
describe("an admin sees each coworker and sets the model calls of a job", () => {
  let buzz: Buzz;
  let firm: Firm;
  let rosa: Awaited<ReturnType<typeof loadPlugin>>;
  beforeAll(async () => {
    buzz = await startBuzz();
    firm = await startFirm({ buzz });
    rosa = await loadPlugin(buzz, "rosa");
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
    await buzz?.[Symbol.asyncDispose]();
  }, E2E);
  const coworkers = (fits: (shown: string[]) => boolean) => rosa.card("Coworkers", fits);
  const firmFile = () => join(firm.folder, "storage", "settings.json");

  test.failing(
    "the owner's card shows each coworker and the limit, and a change holds in the running duck at once",
    async () => {
      const duck = await firm.duckId();
      const card = await coworkers((l) => l.includes(harbor.coworker) && l.includes("Running"));
      expect(await rosa.listed("Coworkers")).toBe(true);
      expect(card.controls["Model calls per job"]?.defaultValue).toBe(JOB_CALLS);
      expect((await card.change("Model calls per job", { value: "2" })).lines).not.toContain(NOT_ADMIN);
      expect(JSON.parse(readFileSync(firmFile(), "utf8"))).toEqual({ jobs: { calls: 2 } });
      expect((await coworkers(() => true)).controls["Model calls per job"]?.defaultValue).toBe(2);

      let item = 0;
      firm.model.on(
        all(coworkerRun, said(ASK)),
        call(TOOLS.writeItem, { title: "Boiler mail", next: "Search" }),
      );
      firm.model.on(answered(TOOLS.writeItem), (r) => {
        item = idIn(r.last);
        return call(TOOLS.startJob, {
          title: "Boiler mail",
          item_id: item,
          brief: BRIEF,
          check: false,
          check_reason: "It stays with Rosa, and nothing goes out.",
        });
      });
      firm.model.on(answered(TOOLS.startJob), say("Searching."));
      // Each call asks for the next page: goose itself ends a run that repeats one call unchanged.
      let page = 0;
      firm.model.on(all(jobRun, shows(BRIEF)), () => call("find_mail", { query: `boiler, page ${++page}` }), {
        times: Number.POSITIVE_INFINITY,
      });
      firm.model.on(all(coworkerRun, said("was cut at its cap of")), say(CAPPED));
      await firm.person.send("desk", ASK);
      await firm.person.nextWith(CAPPED, 120);
      await firm.person.quiet(5);
      expect(firm.model.requests.filter(all(jobRun, shows(BRIEF)))).toHaveLength(2);
      using db = firm.db();
      const end = db
        .query<{ payload: string }, []>(
          "select payload from inbox where source = 'job' and ref like '\"Boiler mail\"%'",
        )
        .get();
      expect(JSON.parse(end?.payload ?? "{}").cut).toStartWith(
        "The worker was cut at its cap of 2 model calls,",
      );
      expect(await firm.duckId()).toBe(duck);
    },
    E2E,
  );

  test.failing(
    "a member who is not an admin has no card, is refused in fixed words, and reads none of what the admin sees",
    async () => {
      const theo = await loadPlugin(buzz, "theo");
      expect(await theo.listed("Coworkers")).toBe(false);
      // Asked from a channel Theo makes with duck himself, since he has no card.
      expect(await buzz.askDuck("theo", firm.duckKey as string, "set model calls per job 50")).toBe(NOT_ADMIN);
      expect(JSON.parse(readFileSync(firmFile(), "utf8"))).toEqual({ jobs: { calls: 2 } });

      // The owner sets it again, so what the admins see is published with the run and its cost.
      await (await coworkers(() => true)).change("Model calls per job", { value: "3" });
      const channel = (await buzz.channelWith("rosa", firm.duckKey as string)) as string;
      const [seen] = await buzz.query("rosa", [
        { artifact: "current", "#h": [channel], "#type": ["duck.firm"] },
      ]);
      const content = JSON.parse(seen?.content as string);
      expect(content).toMatchObject({ version: 1, model_calls_per_job: 3 });
      expect(content.coworkers).toEqual([
        expect.objectContaining({ name: harbor.coworker, state: "claimed", up: true }),
      ]);
      expect(content.coworkers[0].cost).toBeGreaterThan(0);
      expect(content.coworkers[0].last_ran).toEqual(expect.any(String));
      const d = seen?.tags.find((t) => t[0] === "d")?.[1] as string;
      expect(await buzz.query("theo", [{ ids: [seen?.id] }])).toEqual([]);
      expect(await buzz.query("theo", [{ kinds: [45010], "#d": [d] }])).toEqual([]);
      await expect(buzz.query("theo", [{ kinds: [45010], "#h": [channel] }])).rejects.toThrow("restricted");
    },
    E2E,
  );
});

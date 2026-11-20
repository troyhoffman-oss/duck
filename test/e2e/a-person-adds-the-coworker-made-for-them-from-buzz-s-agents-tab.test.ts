import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Buzz, E2E, type Firm, harbor, loadPlugin, startBuzz, startFirm } from "../kit";
import { all, held, said, say, shows } from "../kit/model";

const PICTURE = "https://images.example/pip.png";
const CODE = "The gate code for the annex is 4417.";
const LEASE = "Can you check the annex lease?";
const BOILER = "Is the boiler serviced?";
const SERVICED = "The boiler was serviced in May.";
const BACK = "Back now: the annex lease runs to June, and the annex gate is still 4417.";
const CUT = "cut short by a restart";

/** What podman printed for `args`, or null where it failed. */
async function podman(...args: string[]) {
  const child = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(child.stdout).text()).trim();
  return (await child.exited) === 0 ? out : null;
}
/** The duck container of `firm`: its id and when it started. */
const duckContainer = (firm: Firm) =>
  podman("inspect", "--format", "{{.Id}} {{.State.StartedAt}}", `duck-${firm.name}`);
/**
 * How many processes in the duck container of `firm` serve coworker `coworker`'s buzz door: buzz-acp, known by
 * the door it hands to in its environment, and the `duck buzz` it runs, by the door in its command line. Each
 * is matched from its program's name, so the shell that lists them, whose command line holds both, is not.
 */
async function atDoor(firm: Firm, coworker: string) {
  const door = `/doors/${coworker}/buzz`;
  const listing = `cd /proc && for p in [0-9]*; do c="$(tr '\\0' ' ' < $p/cmdline 2>/dev/null)"; case "$c" in "buzz-acp "*) tr '\\0' '\\n' < $p/environ 2>/dev/null | grep -q "${door}" && echo acp;; "bun "*" buzz http"*"${door}"*) echo buzz;; esac; done`;
  const found = ((await podman("exec", `duck-${firm.name}`, "sh", "-c", listing)) ?? "").split("\n");
  return { acp: found.filter((f) => f === "acp").length, buzz: found.filter((f) => f === "buzz").length };
}
/** Waits up to `seconds` for `ok` to hold, naming `what` if it never does. */
async function eventually(what: string, ok: () => Promise<boolean>, seconds: number) {
  for (const end = Date.now() + seconds * 1000; !(await ok()); await Bun.sleep(500))
    if (Date.now() > end) throw new Error(`waited ${seconds} s for ${what}`);
}

// The plugin's way in (SPEC part 11, The plugin): duck's own plugin code, driven as Buzz's desktop drives it
// for Ana, against a real relay and a real firm. One relay and one firm for every step, which run in order,
// each going on from the last.
describe("a person adds the coworker made for them from Buzz's Agents tab", () => {
  let buzz: Buzz;
  let firm: Firm;
  let plugin: Awaited<ReturnType<typeof loadPlugin>>;
  let lark = "";
  beforeAll(async () => {
    buzz = await startBuzz();
    firm = await startFirm({ buzz });
    // harbor's mail plug calls with a key for each person.
    firm.addSecret("HARBOR_MAIL_KEY_ana");
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
    await buzz?.[Symbol.asyncDispose]();
  }, E2E);
  const duck = () => firm.duckKey as string;
  /** The newest profile of key `of`, as Theo reads it, once `fits` it, waiting up to 60 s. */
  async function profileOf(of: string, fits: (profile: Record<string, unknown>) => boolean) {
    for (const end = Date.now() + 60_000; ; await Bun.sleep(500)) {
      const [newest] = (await buzz.query("theo", [{ kinds: [0], authors: [of] }])).sort(
        (a, b) => b.created_at - a.created_at,
      );
      const profile = newest && {
        ...JSON.parse(newest.content),
        owner: newest.tags.find((t) => t[0] === "auth")?.[1],
        id: newest.id,
      };
      if (profile && fits(profile)) return profile;
      if (Date.now() > end)
        throw new Error(`waited 60 s for a profile of ${of} that fits: ${JSON.stringify(profile)}`);
    }
  }

  test.failing(
    "duck's offer shows in the person's New agent, and duck's own profile says it is duck, with the tag of the community's owner",
    async () => {
      const made = await firm.duck("make", "lark", "ana", "Ana");
      lark = /its Buzz key is ([0-9a-f]{64})/.exec(made)?.[1] as string;
      plugin = await loadPlugin(buzz, "ana");
      expect(plugin.type.title).toBe("duck");
      const offered = "lark, made for you by your firm. The name you give it above is its own.";
      expect((await plugin.create((l) => l.includes(offered))).lines).toEqual(["Your coworker", offered]);
      const own = await profileOf(duck(), (p) => p.duck === true);
      expect(own.owner).toBe(buzz.keys.rosa);
    },
    E2E,
  );

  test.failing(
    "a person adds it in New agent with a name and a picture of their own, and it starts with no admin, showing both",
    async () => {
      expect(await plugin.add("lark", "Pip", PICTURE)).toEqual({ pubkey: lark, picture: PICTURE });
      const facts = firm.facts("lark");
      expect(facts.state).toBe("claimed");
      expect(facts.name).toBe("Ana");
      expect(JSON.parse(facts.owner as string)[1]).toBe(buzz.keys.ana);
      await buzz.person.online(240, lark);
      const shown = await profileOf(lark, (p) => p.name === "Pip" && p.picture === PICTURE);
      expect(shown.owner).toBe(buzz.keys.ana);
    },
    E2E,
  );

  test.failing(
    "a person's new name for it in Buzz is its profile's, and the same claim sent again still stands",
    async () => {
      await plugin.edit(lark, "Pippa", PICTURE);
      await profileOf(lark, (p) => p.name === "Pippa");
      expect(firm.facts("lark").called).toBe("Pippa");
      await plugin.finish("lark", lark, "Pippa");
      expect(firm.facts("lark").state).toBe("claimed");
    },
    E2E,
  );

  test.failing(
    "deleting it in Buzz stops it and keeps its folder, and adding it again brings it back as it was",
    async () => {
      const before = firm.facts("lark");
      await plugin.remove(lark);
      expect(firm.facts("lark").state).toBe("stopped");
      for (const end = Date.now() + 240_000; (await buzz.presence(lark)) === "online"; await Bun.sleep(1000))
        if (Date.now() > end) throw new Error("lark is still online 240 s after it was deleted");
      await plugin.add("lark", "Pippa");
      const after = firm.facts("lark");
      expect(after.state).toBe("claimed");
      expect(after.made_at).toBe(before.made_at as string);
      expect(after.called).toBe("Pippa");
      expect(after.picture).toBe(PICTURE);
      await buzz.person.online(240, lark);
    },
    E2E,
  );

  test.failing(
    "a coworker whose profile Buzz already shows keeps its name, picture and about across a duck restart, and its person's rename in Buzz changes only its name",
    async () => {
      const wren = buzz.keys.wren;
      const kept = {
        name: "Wren of Harbor",
        picture: "https://images.example/wren.png",
        about: "Harbor's ops desk",
      };
      await buzz.profileAs(firm.buzzSecret(harbor.coworker), buzz.tagFor(wren), kept);
      const set = await profileOf(wren, (p) => p.display_name === kept.name);
      await firm.stop();
      await firm.start();
      await buzz.person.online(240, wren);
      // duck publishes at start without waiting; a profile it sent would be in well before this.
      await Bun.sleep(10_000);
      expect((await profileOf(wren, () => true)).id).toBe(set.id);
      await (await loadPlugin(buzz, "rosa")).edit(wren, "Wrenna");
      const renamed = await profileOf(wren, (p) => p.display_name === "Wrenna");
      expect(renamed).toMatchObject({
        name: "Wrenna",
        picture: kept.picture,
        about: kept.about,
        owner: buzz.keys.rosa,
      });
    },
    E2E,
  );

  test.failing(
    "a person's delete in Buzz stops only their coworker, inside the running duck: another coworker's run goes on, duck's container stays, and nothing of the stopped one answers",
    async () => {
      firm.model.on(said(CODE), say("Noted: 4417 for the annex."));
      await buzz.write("ana", "dm", CODE, { to: lark });
      expect((await buzz.answerFrom("ana", lark, 60)).content).toBe("Noted: 4417 for the annex.");
      firm.model.on(said(LEASE), held("lark", say("never sent")));
      firm.model.on(said(BOILER), held("wren", say(SERVICED)));
      await buzz.write("ana", "dm", LEASE, { to: lark });
      await firm.model.reached("lark");
      await buzz.person.send(BOILER);
      await firm.model.reached("wren");
      const before = await duckContainer(firm);
      expect(before).toBeTruthy();
      await plugin.remove(lark);
      expect(firm.facts("lark").state).toBe("stopped");
      await eventually(
        "lark's goose container to be gone",
        async () => (await podman("container", "exists", `duck-${firm.name}-lark`)) === null,
        120,
      );
      await eventually(
        "no buzz-acp or duck buzz at lark's door",
        async () => Object.values(await atDoor(firm, "lark")).every((n) => n === 0),
        30,
      );
      expect((await fetch(`${firm.address}/doors/lark/buzz`, { method: "POST", body: "{}" })).status).toBe(
        404,
      );
      firm.model.release("wren");
      expect((await buzz.person.next(60)).content).toBe(SERVICED);
      expect(await duckContainer(firm)).toBe(before);
      expect((await atDoor(firm, harbor.coworker)).acp).toBe(1);
      await firm.step();
    },
    E2E,
  );

  test.failing(
    "claimed again in the same duck, the stopped coworker starts clean: the run the stop cut short comes back once, with its memory, and one buzz-acp serves it",
    async () => {
      firm.model.on(all(said(LEASE), shows(CUT), shows(CODE)), say(BACK));
      const before = await duckContainer(firm);
      await plugin.add("lark", "Pippa");
      expect(firm.facts("lark").state).toBe("claimed");
      await eventually(
        "lark's answer to the run the stop cut short",
        async () => (await buzz.dmOf("ana", lark)).some((m) => m.content === BACK),
        120,
      );
      // A connection, timer or door left from its life before the stop would answer again or touch its closed
      // database.
      await Bun.sleep(5000);
      expect((await buzz.dmOf("ana", lark)).filter((m) => m.content === BACK)).toHaveLength(1);
      expect(firm.model.requests.filter(shows(CUT))).toHaveLength(1);
      expect((await atDoor(firm, "lark")).acp).toBe(1);
      expect(await duckContainer(firm)).toBe(before);
      expect(await firm.logs()).not.toMatch(/closed database|Database has closed/);
      await firm.step();
    },
    E2E,
  );
});

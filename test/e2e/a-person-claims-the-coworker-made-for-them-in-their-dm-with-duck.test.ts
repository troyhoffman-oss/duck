import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Buzz, E2E, type Firm, startBuzz, startFirm } from "../kit";
import type { Writer } from "../kit/buzz";

const HELLO = "Hi, what can you do here?";
const YOURS =
  "That coworker is yours now. duck is starting it, and it answers in its own DM once it is running.";
const NOT_FIT = "That proof does not fit a coworker made for you here, so nothing changed.";
const MINE = "That coworker is yours already.";

// The join path in duck's DMs (SPEC part 11), as a person and an admin see it. One relay and one firm for
// every step, since each pays a relay and a firm start; the steps run in order, each going on from the last.
describe("a person claims the coworker made for them in their DM with duck", () => {
  let buzz: Buzz;
  let firm: Firm;
  beforeAll(async () => {
    buzz = await startBuzz();
    firm = await startFirm({ buzz });
    // harbor's mail plug calls with a key for each person; the one for ana_kite comes later.
    for (const handle of ["ana", "ana_tern"]) firm.addSecret(`HARBOR_MAIL_KEY_${handle}`);
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
    await buzz?.[Symbol.asyncDispose]();
  }, E2E);
  const duck = () => firm.duckKey as string;
  /** duck's `n`th message in `who`'s DM with it, waiting up to 60 s for it. */
  async function nth(who: Writer, n: number) {
    for (const end = Date.now() + 60_000; ; await Bun.sleep(250)) {
      const said = (await buzz.dmOf(who, duck()))[n - 1];
      if (said) return said;
      if (Date.now() > end) throw new Error(`waited 60 s for duck's message ${n} in ${who}'s DM`);
    }
  }
  /** The Buzz key of coworker `coworker`, from duck's offer of it in Ana's DM, waiting up to 60 s for the offer. */
  async function offered(coworker: string) {
    for (const end = Date.now() + 60_000; ; await Bun.sleep(250)) {
      const offer = (await buzz.dmOf("ana", duck())).find((m) =>
        m.content.includes(`coworker for you: ${coworker}.`),
      );
      const key = offer && /^[0-9a-f]{64}$/m.exec(offer.content)?.[0];
      if (key) return key;
      if (Date.now() > end) throw new Error(`waited 60 s for duck's offer of ${coworker} to Ana`);
    }
  }

  test(
    "a member who writes to duck in their DM gets one answer in fixed words, which sends them to their coworker's own DM",
    async () => {
      const duck = firm.duckKey as string;
      expect(duck).toMatch(/^[0-9a-f]{64}$/);
      await buzz.write("theo", "dm", HELLO, { to: duck });
      const answer = await buzz.answerFrom("theo", duck, 60);
      expect(answer.content).toContain("To talk with your coworker, write to it in its own DM.");
      await Bun.sleep(5000);
      expect(await buzz.dmOf("theo", duck)).toHaveLength(1);
    },
    E2E,
  );

  test(
    "an admin's duck make for a Buzz name that is not exactly one person's is refused, and nothing is made",
    async () => {
      await expect(firm.duck("make", "lark", "ana", "Nobody")).rejects.toThrow('named "Nobody"');
      await buzz.rename("theo", "Ana");
      try {
        await expect(firm.duck("make", "lark", "ana", "Ana")).rejects.toThrow('named "Ana"');
      } finally {
        await buzz.rename("theo", "Theo");
      }
    },
    E2E,
  );

  test(
    "an admin's duck make for a person by their Buzz name tells them once, in their DM with duck, the coworker's name, its Buzz key and how to claim it",
    async () => {
      const duck = firm.duckKey as string;
      const made = await firm.duck("make", "lark", "ana", "Ana");
      const lark = /its Buzz key is ([0-9a-f]{64})/.exec(made)?.[1] as string;
      expect(lark).toMatch(/^[0-9a-f]{64}$/);
      const offer = await buzz.answerFrom("ana", duck, 60);
      expect(offer.content).toContain("lark");
      expect(offer.content).toContain(lark);
      expect(offer.content).toContain("Settings, then Security, then Authorize external identity");
      await Bun.sleep(5000);
      expect(await buzz.dmOf("ana", duck)).toHaveLength(1);
    },
    E2E,
  );

  test(
    "a proof in duck's DM that does not fit a coworker made for the one who sends it gets fixed words, and nothing is claimed",
    async () => {
      const lark = await offered("lark");
      // Ana's proof sent by Theo, Theo's own proof for Ana's coworker, and Ana's proof for a key duck never made.
      await buzz.write("theo", "dm", buzz.proof("ana", lark), { to: duck() });
      expect((await nth("theo", 2)).content).toBe(NOT_FIT);
      await buzz.write("theo", "dm", buzz.proof("theo", lark), { to: duck() });
      expect((await nth("theo", 3)).content).toBe(NOT_FIT);
      await buzz.write("ana", "dm", buzz.proof("ana", buzz.keys.heron), { to: duck() });
      expect((await nth("ana", 2)).content).toBe(NOT_FIT);
      await Bun.sleep(5000);
      expect(await buzz.dmOf("theo", duck())).toHaveLength(3);
      expect(await buzz.dmOf("ana", duck())).toHaveLength(2);
      expect(firm.facts("lark").state).toBe("unclaimed");
    },
    E2E,
  );

  test(
    "a person who pastes in duck's DM the proof for the coworker made for them is told in fixed words it is theirs, and it starts with no admin",
    async () => {
      const lark = await offered("lark");
      const proof = buzz.proof("ana", lark);
      await buzz.write("ana", "dm", proof, { to: duck() });
      expect((await nth("ana", 3)).content).toBe(YOURS);
      const facts = firm.facts("lark");
      expect(facts.state).toBe("claimed");
      expect(facts.handle).toBe("ana");
      // The person's own Buzz name, as she gave it.
      expect(facts.name).toBe("Ana");
      expect(JSON.parse(facts.owner as string)).toEqual(JSON.parse(proof));
      await buzz.person.online(240, lark);
    },
    E2E,
  );

  test(
    "a make for a person waits for their plug key, and a claim in duck's DM that comes while duck installs for an earlier one is not lost",
    async () => {
      const kiteKey = "HARBOR_MAIL_KEY_ana_kite";
      await expect(firm.duck("make", "kite", "ana_kite", buzz.keys.ana)).rejects.toThrow(kiteKey);
      firm.addSecret(kiteKey);
      await firm.duck("make", "kite", "ana_kite", buzz.keys.ana);
      await firm.duck("make", "tern", "ana_tern", buzz.keys.ana);
      const [kite, tern] = [await offered("kite"), await offered("tern")];
      expect((await nth("ana", 5)).content).toContain("paste the proof here as your reply");
      await buzz.write("ana", "dm", buzz.proof("ana", kite), { to: duck() });
      expect((await nth("ana", 6)).content).toBe(YOURS);
      let first = await firm.claimInstall();
      for (const end = Date.now() + 60_000; first.state !== "activating"; first = await firm.claimInstall()) {
        if (Date.now() > end)
          throw new Error(`duck's install after kite's claim is ${first.state}, not running`);
        await Bun.sleep(100);
      }
      await buzz.write("ana", "dm", buzz.proof("ana", tern), { to: duck() });
      expect((await nth("ana", 7)).content).toBe(YOURS);
      // Tern's claim was taken while the install kite's claim started still ran.
      expect(await firm.claimInstall()).toEqual(first);
      await buzz.person.online(400, kite);
      await buzz.person.online(400, tern);
      // The file tern's claim left has the unit run again once the run kite's claim started ends; the step
      // waits for that run to finish.
      const end = Date.now() + 240_000;
      for (let now = first; now.run === first.run || now.state !== "inactive"; await Bun.sleep(250)) {
        now = await firm.claimInstall();
        if (Date.now() > end) throw new Error(`duck's install for tern's claim is ${now.state}, not done`);
      }
    },
    3 * E2E,
  );

  test(
    "with duck's DM gone from the setup, duck install takes away the units it wrote for claims in it",
    async () => {
      const claims = [".path", ".service"].map((kind) => `duck-firm-${firm.name}-install${kind}`);
      expect(firm.units()).toEqual(expect.arrayContaining(claims));
      firm.edit((setup) => {
        delete setup.buzz?.owner;
      });
      await firm.duck("install");
      expect(firm.units()).toEqual([`duck-firm-${firm.name}.service`]);
    },
    E2E,
  );

  test(
    "an admin's duck make for a person with no handle is refused, since a claim in duck's DM gives none, and nothing is made",
    async () => {
      firm.edit((setup) => {
        if (setup.buzz) setup.buzz.owner = buzz.tagFor(duck());
      });
      await expect(firm.duck("make", "finch", "", buzz.keys.ana)).rejects.toThrow('"" is not a handle');
      expect(() => firm.facts("finch")).toThrow();
    },
    E2E,
  );

  test(
    "a person who pastes again the proof of the coworker they claimed is told in fixed words it is theirs already, and anyone else who pastes it learns nothing",
    async () => {
      // The step before put duck's DM back in the setup; installing it starts duck with its DM on.
      await firm.duck("install");
      const lark = await offered("lark");
      await buzz.write("ana", "dm", buzz.proof("ana", lark), { to: duck() });
      expect((await nth("ana", 8)).content).toBe(MINE);
      await buzz.write("theo", "dm", buzz.proof("ana", lark), { to: duck() });
      expect((await nth("theo", 4)).content).toBe(NOT_FIT);
      expect(firm.facts("lark").state).toBe("claimed");
    },
    E2E,
  );
});

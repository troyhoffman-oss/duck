import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type Buzz, E2E, type Firm, loadPlugin, startBuzz, startFirm } from "../kit";

const NOT_FIT = "That proof does not fit a coworker made for you here, so nothing changed.";
const MINE = "That coworker is yours already.";
const NOT_ADMIN = "Only an owner or admin of this community sets that, so nothing changed.";
const LIMITED = "Done: a job's run is cut off at that many model calls from its next call.";
const OFFERED = "lark, made for you by your firm. The name you give it above is its own.";

// The join path (SPEC part 11, duck's channel), as a person and an admin see it: the person in duck's plugin,
// driven as Buzz's desktop drives it, and the admin at duck's command line. One relay and one firm for every
// step, since each pays a relay and a firm start; the steps run in order, each going on from the last.
describe("a person claims the coworker made for them, and nothing of it shows in Buzz", () => {
  let buzz: Buzz;
  let firm: Firm;
  let plugin: Awaited<ReturnType<typeof loadPlugin>>;
  let lark = "";
  /** The setup's Buzz, while a step has taken it out. */
  let relay: { relay: string } | undefined;
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
    "an admin's duck make for a person by their Buzz name shows it in their New agent, from a channel only they and duck read, which Buzz lists nowhere and where nothing counts as unread or notifies",
    async () => {
      const made = await firm.duck("make", "lark", "ana", "Ana");
      lark = /its Buzz key is ([0-9a-f]{64})/.exec(made)?.[1] as string;
      expect(lark).toMatch(/^[0-9a-f]{64}$/);
      plugin = await loadPlugin(buzz, "ana");
      const shown = await plugin.create((l) => l.includes(OFFERED));
      expect(shown.lines).toEqual(["Your coworker", OFFERED]);

      const channel = (await buzz.channelWith("ana", duck())) as string;
      expect(channel).toBeString();
      const [offer] = await buzz.query("ana", [
        { artifact: "current", "#h": [channel], "#type": ["duck.offer"] },
      ]);
      expect(offer?.pubkey).toBe(duck());
      expect(offer?.tags).toContainEqual(["agent", lark]);
      // Buzz counts as unread, and notifies of, these kinds alone (buzz-app src/features/relay/unread.ts:327-328).
      expect(await buzz.query("ana", [{ kinds: [9, 40002, 40008], "#h": [channel] }])).toEqual([]);
      const listed = await buzz.listed("ana");
      expect(listed).not.toContain(channel);
      expect(listed).not.toContain(duck());
      await expect(buzz.query("theo", [{ kinds: [45010], "#h": [channel] }])).rejects.toThrow("restricted");
    },
    E2E,
  );

  test(
    "a proof that does not fit a coworker made for the one who sends it is refused in fixed words, one sent from a channel duck did not make gets no answer, and nothing is claimed",
    async () => {
      // Ana's proof sent by Theo, and Theo's own proof for Ana's coworker, from a channel Theo makes with duck in
      // it and his own key as its label, which duck never reads.
      expect(await buzz.askDuck("theo", duck(), buzz.proof("ana", lark), 15)).toBeUndefined();
      expect(await buzz.askDuck("theo", duck(), buzz.proof("theo", lark), 15)).toBeUndefined();
      // Theo's proof for Ana's coworker sent by Ana, and Ana's proof for a key duck never made, from New agent.
      expect(await buzz.askDuck("ana", duck(), buzz.proof("theo", lark))).toBe(NOT_FIT);
      await expect(plugin.finish("lark", buzz.keys.heron, "Lark")).rejects.toThrow(NOT_FIT);
      expect(firm.facts("lark").state).toBe("unclaimed");
    },
    E2E,
  );

  test(
    "a person who adds in New agent the coworker made for them has it as theirs, and it starts with no admin",
    async () => {
      expect(await plugin.add("lark", "Lark")).toEqual({ pubkey: lark });
      const facts = firm.facts("lark");
      expect(facts.state).toBe("claimed");
      expect(facts.handle).toBe("ana");
      // The person's own Buzz name, as she gave it.
      expect(facts.name).toBe("Ana");
      expect(JSON.parse(facts.owner as string)[1]).toBe(buzz.keys.ana);
      await buzz.person.online(240, lark);
    },
    E2E,
  );

  test(
    "a make for a person waits for their plug key, and a claim that comes while duck installs for an earlier one is not lost and holds that install up for nobody",
    async () => {
      const kiteKey = "HARBOR_MAIL_KEY_ana_kite";
      await expect(firm.duck("make", "kite", "ana_kite", buzz.keys.ana)).rejects.toThrow(kiteKey);
      firm.addSecret(kiteKey);
      const keyOf = (made: string) => /its Buzz key is ([0-9a-f]{64})/.exec(made)?.[1] as string;
      const kite = keyOf(await firm.duck("make", "kite", "ana_kite", buzz.keys.ana));
      const tern = keyOf(await firm.duck("make", "tern", "ana_tern", buzz.keys.ana));
      await plugin.create(
        (l) => l.some((t) => t.startsWith("kite,")) && l.some((t) => t.startsWith("tern,")),
      );
      // Kite's claim starts an install. Once kite's goose container is there, that install has read the setup
      // and is waiting for duck; the step freezes it there while tern's claim comes, so the claim lands inside
      // it every time.
      const since = new Date();
      const added = plugin.add("kite", "Kite");
      for (const end = Date.now() + 60_000; !(await firm.goose("kite")); await Bun.sleep(50))
        if (Date.now() > end) throw new Error("no goose container for kite 60 s after its claim");
      let claimed = 0;
      let first = { state: "", run: "" };
      try {
        await firm.freezeInstall(true);
        first = await firm.claimInstall();
        expect(first.state).toBe("activating");
        await added;
        await plugin.add("tern", "Tern");
        claimed = Date.now();
        expect(firm.facts("tern").state).toBe("claimed");
        expect(await firm.claimInstall()).toEqual(first);
      } finally {
        await firm.freezeInstall(false);
      }
      // Kite's run ends without waiting on tern, which it did not install, and the file tern's claim left has
      // the unit run again for tern; the step waits for that run to finish.
      const end = Date.now() + 240_000;
      for (let now = first; now.run === first.run || now.state !== "inactive"; await Bun.sleep(250)) {
        now = await firm.claimInstall();
        if (Date.now() > end) throw new Error(`duck's install for tern's claim is ${now.state}, not done`);
      }
      expect(await firm.installLog(since)).not.toContain("is not ready");
      await buzz.person.online(400, kite);
      await buzz.person.online(60, tern);
      // Tern is up well within a minute of its claim; an install held up by it waited 120 s before tern's began.
      expect(Date.now() - claimed).toBeLessThan(60_000);
    },
    3 * E2E,
  );

  test(
    "with Buzz gone from the setup, duck install takes away the units it wrote for claims from Buzz",
    async () => {
      const claims = [".path", ".service"].map((kind) => `duck-firm-${firm.name}-install${kind}`);
      expect(firm.units()).toEqual(expect.arrayContaining(claims));
      firm.edit((setup) => {
        relay = setup.buzz;
        delete setup.buzz;
      });
      await firm.duck("install");
      expect(firm.units()).toEqual([`duck-firm-${firm.name}.service`]);
    },
    E2E,
  );

  test(
    "an admin's duck make for a person with no handle is refused, since a claim from Buzz gives none, and nothing is made",
    async () => {
      firm.edit((setup) => {
        setup.buzz = relay;
      });
      await expect(firm.duck("make", "finch", "", buzz.keys.ana)).rejects.toThrow('"" is not a handle');
      expect(() => firm.facts("finch")).toThrow();
    },
    E2E,
  );

  test(
    "a person who sends again the proof of the coworker they claimed is told in fixed words it is theirs already, and anyone else who sends it learns nothing",
    async () => {
      // The step before put Buzz back in the setup; installing it starts duck with its channels on.
      await firm.duck("install");
      expect(await buzz.askDuck("ana", duck(), buzz.proof("ana", lark))).toBe(MINE);
      expect(await buzz.askDuck("theo", duck(), buzz.proof("ana", lark), 15)).toBeUndefined();
      expect(firm.facts("lark").state).toBe("claimed");
    },
    E2E,
  );

  test(
    "a person who is not an admin and asks for the job limit in their channel with duck is refused in fixed words",
    async () => {
      expect(await buzz.askDuck("ana", duck(), "set model calls per job 50")).toBe(NOT_ADMIN);
    },
    E2E,
  );

  test(
    "a member who poses as duck, with a profile that says so, a tag no owner signed and a channel like duck's, is shown to nobody and sent no proof",
    async () => {
      const junk = ["auth", buzz.keys.rosa, "", "00".repeat(64)];
      await buzz.publish("theo", buzz.sign("theo", 0, [junk], JSON.stringify({ name: "duck", duck: true })));
      const fake = randomUUID();
      const made = { h: fake, name: "duck", channel_type: "system", visibility: "private", t: buzz.keys.ana };
      await buzz.publish(
        "theo",
        buzz.sign("theo", 9007, [...Object.entries(made), ["p", buzz.keys.ana]], ""),
      );
      const offer = (tags: string[][]) => {
        const envelope = {
          ar: "1",
          d: randomUUID(),
          h: fake,
          type: "duck.offer",
          title: "heron",
          op: "create",
        };
        const content = JSON.stringify({ version: 1, coworker: "heron" });
        return buzz.sign(
          "theo",
          45010,
          [...Object.entries(envelope), ["agent", buzz.keys.heron], ...tags],
          content,
        );
      };
      // The relay takes an artifact's auth tag only where its owner signed the artifact's author's key.
      await expect(buzz.publish("theo", offer([junk]))).rejects.toThrow("unverified artifact auth tag");
      await buzz.publish("theo", offer([]));
      const shown = await (await loadPlugin(buzz, "ana")).create((l) => !l[0]?.endsWith("…"));
      expect(shown.lines.join(" ")).not.toContain("heron");
      await expect(plugin.add("heron", "Heron")).rejects.toThrow();
      expect(await buzz.query("ana", [{ kinds: [45010], "#h": [fake], authors: [buzz.keys.ana] }])).toEqual(
        [],
      );
    },
    E2E,
  );

  test(
    "an agent the owner authorised but did not make admin, whose channel like duck's for a person is older than duck's and holds an offer, is not taken for duck",
    async () => {
      // Heron stands in for a coworker: an agent the owner's tag authorises, on no member list as an admin.
      const tag = JSON.parse(buzz.tagFor(buzz.keys.heron)) as string[];
      const fake = randomUUID();
      const made = {
        h: fake,
        name: "duck",
        channel_type: "system",
        visibility: "private",
        t: buzz.keys.theo,
      };
      const channel = [...Object.entries(made), ["p", buzz.keys.theo], tag];
      await buzz.publish("heron", buzz.sign("heron", 9007, channel, ""));
      const envelope = {
        ar: "1",
        d: randomUUID(),
        h: fake,
        type: "duck.offer",
        title: "heron",
        op: "create",
      };
      const offer = [...Object.entries(envelope), ["agent", buzz.keys.heron], tag];
      await buzz.publish(
        "heron",
        buzz.sign("heron", 45010, offer, JSON.stringify({ version: 1, coworker: "heron" })),
      );
      firm.addSecret("HARBOR_MAIL_KEY_theo");
      await firm.duck("make", "robin", "theo", buzz.keys.theo);
      const shown = await (await loadPlugin(buzz, "theo")).create((l) =>
        l.some((t) => t.startsWith("robin,")),
      );
      expect(shown.lines.join(" ")).not.toContain("heron");
    },
    E2E,
  );

  test.failing(
    "a duck the owner makes a member again says the owner's step once in its log, and duck check names duck's key and that step as still to do until the owner makes it an admin again",
    async () => {
      const told = `duck's Buzz key ${duck()} is not an admin`;
      const times = async () => (await firm.logs()).split(told).length - 1;
      const before = await times();
      const role = (to: string) =>
        buzz.publish(
          "rosa",
          buzz.sign(
            "rosa",
            9032,
            [
              ["p", duck()],
              ["role", to],
            ],
            "",
          ),
        );
      await role("member");
      // An admin's request has duck read the member list twice: for the request, and for the card it publishes.
      expect(await buzz.askDuck("rosa", duck(), "set model calls per job 40")).toBe(LIMITED);
      expect((await times()) - before).toBe(1);
      const check = await firm.duck("check");
      expect(check).toContain(`duck's Buzz key is ${duck()}`);
      expect(check).toContain("Community admin, then Membership");
      await role("admin");
      expect(await buzz.askDuck("rosa", duck(), "set model calls per job 50")).toBe(LIMITED);
      expect(await firm.duck("check")).not.toContain(duck());
    },
    E2E,
  );
});

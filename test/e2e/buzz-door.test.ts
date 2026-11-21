import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  all,
  answered,
  type Buzz,
  both,
  call,
  E2E,
  type Firm,
  harbor,
  held,
  type ModelRequest,
  reading,
  said,
  say,
  shows,
  startBuzz,
  startFirm,
  TOOLS,
  until,
} from "../kit";

const FIRST = "I'll pull the 4B lease.";
const ANSWER = "The 4B lease runs to March 31, and the gate code is 2468.";
const DRAFT = "/duck/home/renewal-4B.txt";

// The Buzz door's contract test: a throwaway relay, Buzz's own buzz-acp and CLI at the versions duck pins.
// One firm for both, since each pays a relay and a firm start. They run in this order: the second's rules
// match any run of the main conversation, so they are given after the first's are used.
describe("the Buzz door", () => {
  let buzz: Buzz;
  let firm: Firm;
  beforeAll(async () => {
    buzz = await startBuzz();
    firm = await startFirm({ buzz });
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
    await buzz?.[Symbol.asyncDispose]();
  }, E2E);

  test(
    "the Buzz door: in a DM with the coworker the person gets its first line and answer, steers its run, shares one conversation with the other doors and sends and gets files; buzz-acp ending is noticed and it is started again",
    async () => {
      firm.model.on(said("The gate code for 4B is 2468."), say("Noted, 2468 for 4B."));
      await firm.person.send("desk", "The gate code for 4B is 2468.");
      await firm.person.nextWith("Noted", 30);

      firm.model.on(said("Can you pull the 4B lease?"), both(say(FIRST), call("shell", { command: "true" })));
      firm.model.on(answered("shell"), held("pulling", say("Pulled the lease.")));
      firm.model.on(shows("And the gate code?"), say(ANSWER));
      await buzz.person.online();
      const sent = await buzz.person.send("Can you pull the 4B lease?");
      const first = await buzz.person.next(30);
      expect(first.content).toBe(FIRST);
      console.log(
        `buzz door: the first line was in Buzz ${Math.round(first.at - sent)} ms after the person's send`,
      );
      await firm.model.reached("pulling");
      await buzz.person.send("And the gate code?");
      const db = firm.db();
      const steered = () =>
        db
          .query<{ state: string }, []>("select state from inbox where source = 'buzz' order by id")
          .all()
          .map((e) => e.state);
      await until(
        "the message written mid-run handed to that run",
        () => steered().join() === "running,running",
        30,
      );
      firm.model.release("pulling");
      expect((await buzz.person.next(30)).content).toBe(ANSWER);
      expect(
        firm.model.requests.findLast(shows("And the gate code?"))?.shows("The gate code for 4B is 2468."),
      ).toBe(true);
      expect(firm.person.received).toHaveLength(1);

      firm.model.on(said("Here's the 4B lease."), (r) =>
        call("shell", {
          command: `cat ${/\/duck\/files\/\S+lease-4B\.txt/.exec(r.last)?.[0]} && printf 'Renewal draft for 4B' > ${DRAFT}`,
        }),
      );
      firm.model.on(answered("shell"), say(`The renewal draft is at ${DRAFT}`));
      await buzz.person.send("Here's the 4B lease.", [{ name: "lease-4B.txt", bytes: "Rent: 2,400" }]);
      const reply = await buzz.person.next(30);
      expect(reply.content).toStartWith("The renewal draft is at ");
      expect(firm.model.requests.findLast(answered("shell"))?.shows("Rent: 2,400")).toBe(true);
      const url = reply.tags.find((t) => t[0] === "imeta")?.find((e) => e.startsWith("url "));
      expect((await buzz.person.file(String(url?.slice(4)))).toString()).toBe("Renewal draft for 4B");

      // buzz-acp ending is noticed and it is started again, so the person's next DM is answered.
      const ended = await firm.endIn("buzz-acp");
      const started = async () => ![undefined, ended].includes(await firm.pidIn("buzz-acp"));
      for (const end = Date.now() + 30_000; !(await started()); await Bun.sleep(200))
        if (Date.now() > end) throw new Error("buzz-acp is not started again 30 s after it ended");
      await buzz.person.online();
      firm.model.on(said("Is 5C renewed?"), say("5C renews on June 30."));
      await buzz.person.send("Is 5C renewed?");
      expect((await buzz.person.next(30)).content).toBe("5C renews on June 30.");
      const stops = (await firm.logs())
        .split("\n")
        .filter((l) => l.startsWith(`buzz-acp at ${harbor.coworker}.buzz stopped:`));
      expect(stops).toHaveLength(1);
      db.close();
    },
    E2E,
  );

  test(
    "the coworker works in Buzz as itself: it reads Buzz's help, lists where it is, reads a channel, writes there and in a DM to another agent, whose answers come back to its conversation, gives and gets files by name and no path, saves none through a link, and a delete waits for its person's yes",
    async () => {
      const THEO = "The 4B boiler is fixed.";
      const TO_HERON = "@Heron could you send the 4B rent roll?";
      const HERON_THREAD = "Rent roll: 4B pays $2,400 a month.";
      const TO_HERON_DM = "Could you send me the 4B boiler invoice?";
      const HERON_DM = "The boiler invoice is $640.";
      /** A run of the main conversation, which has the list and not `tell`. */
      const main = (r: ModelRequest) => r.has(TOOLS.writeItem) && !r.has(TOOLS.tell);
      /** The main conversation shown what `buzz` printed, holding `text`. */
      const printed = (text: string) => all(main, answered(TOOLS.buzz), said(text));
      const { channel, keys } = buzz;
      await buzz.write("theo", "harbor-ops", THEO, { mention: false });
      await buzz.person.online();
      /** Whether the coworker's next message is `text`; a wait that ends first names the firm's trouble, if any. */
      const answer = async (text: string) => {
        const next = await buzz.person.next(60).catch((error) => {
          firm.trouble.check();
          throw error;
        });
        return next.content === text;
      };

      // Buzz's help, through the tool.
      firm.model.on(all(main, said("What can you do in Buzz?")), call(TOOLS.buzz, { args: ["--help"] }));
      firm.model.on(printed("Usage: buzz"), say("I can use all of Buzz's commands."));
      await buzz.person.send("What can you do in Buzz?");
      expect(await answer("I can use all of Buzz's commands.")).toBe(true);

      // The channels it is in.
      firm.model.on(
        all(main, said("Which channels are you in?")),
        call(TOOLS.buzz, { args: ["channels", "list", "--member"] }),
      );
      firm.model.on(printed(channel), say("I'm in harbor-ops."));
      await buzz.person.send("Which channels are you in?");
      expect(await answer("I'm in harbor-ops.")).toBe(true);

      // Theo's earlier message, read from the channel.
      firm.model.on(
        all(main, said("What did Theo say in harbor-ops?")),
        call(TOOLS.buzz, { args: ["messages", "get", "--channel", channel] }),
      );
      firm.model.on(printed(THEO), say(`Theo said: ${THEO}`));
      await buzz.person.send("What did Theo say in harbor-ops?");
      expect(await answer(`Theo said: ${THEO}`)).toBe(true);

      // A message to Heron in the channel, free, and Heron's answer in its thread back in the conversation.
      let asked = "";
      firm.model.on(
        all(main, said("Ask Heron in harbor-ops for the 4B rent roll.")),
        call(TOOLS.buzz, {
          args: ["messages", "send", "--channel", channel, "--mention", keys.heron, "--content", "-"],
          input: TO_HERON,
        }),
      );
      firm.model.on(printed("event_id"), (r) => {
        asked = /"event_id":\s*"([0-9a-f]{64})"/.exec(r.last)?.[1] ?? "";
        return say("I've asked Heron.");
      });
      await buzz.person.send("Ask Heron in harbor-ops for the 4B rent roll.");
      expect(await answer("I've asked Heron.")).toBe(true);
      const inChannel = (await buzz.inHarborOps("theo")).filter((m) => m.content === TO_HERON);
      expect(inChannel.map((m) => m.id)).toEqual([asked]);
      firm.model.on(all(main, said(HERON_THREAD)), say(`Heron says: ${HERON_THREAD}`));
      await buzz.write("heron", "harbor-ops", HERON_THREAD, { reply: asked });
      expect(await answer(`Heron says: ${HERON_THREAD}`)).toBe(true);

      // A DM to Heron, an agent, and Heron's answer there back in the conversation.
      firm.model.on(
        all(main, said("DM Heron for the boiler invoice.")),
        call(TOOLS.buzz, { args: ["dms", "open", "--pubkey", keys.heron] }),
      );
      firm.model.on(printed("dm_id"), (r) =>
        call(TOOLS.buzz, {
          args: [
            "messages",
            "send",
            "--channel",
            /"dm_id":\s*"([0-9a-f-]{36})"/.exec(r.last)?.[1] ?? "",
            "--content",
            "-",
          ],
          input: TO_HERON_DM,
        }),
      );
      firm.model.on(printed("event_id"), say("I've written to Heron."));
      await buzz.person.send("DM Heron for the boiler invoice.");
      expect(await answer("I've written to Heron.")).toBe(true);
      firm.model.on(all(main, said(HERON_DM)), say(`Heron says: ${HERON_DM}`));
      await buzz.write("heron", "dm", HERON_DM);
      expect((await buzz.dmOf("heron")).map((m) => m.content)).toEqual([TO_HERON_DM]);
      expect(await answer(`Heron says: ${HERON_DM}`)).toBe(true);
      // Both answers reached the main conversation, which shows what the person asked before them.
      const back = [HERON_THREAD, HERON_DM].map((t) => firm.model.requests.find(said(t)));
      expect(back.map((r) => r && main(r) && r.shows("Ask Heron in harbor-ops"))).toEqual([true, true]);

      // A path in its arguments is refused before Buzz's CLI runs: one through a link the coworker made out of
      // its home and up, and one from the root. Nothing is read.
      const ESCAPE = "a/../proc/self/environ";
      firm.model.on(
        all(main, said("Upload the environment file.")),
        call("shell", { command: "ln -s / /duck/home/a" }),
      );
      firm.model.on(
        all(main, answered("shell")),
        call(TOOLS.buzz, { args: ["upload", "file", "--file", ESCAPE] }),
      );
      firm.model.on(
        printed("is a path"),
        call(TOOLS.buzz, { args: ["upload", "file", "--file", "/proc/self/environ"] }),
      );
      firm.model.on(printed("is a path"), say("I can't upload that."));
      await buzz.person.send("Upload the environment file.");
      expect(await answer("I can't upload that.")).toBe(true);
      const calls = (await firm.logs())
        .split("\n")
        .filter((l) => l.startsWith('{"gate"'))
        .map((l) => JSON.parse(l) as { tool: string; outcome: string; why?: string });
      const refused = calls.filter((c) => c.tool === TOOLS.buzz && c.outcome === "refused");
      expect(refused.map((c) => c.why?.split(" is a path")[0])).toEqual([
        `buzz was not run: ${ESCAPE}`,
        "buzz was not run: /proc/self/environ",
      ]);
      // What the coworker got back for each is the refusal alone. Buzz's help, shown before, names the variables.
      const told = firm.model.requests.filter(printed("is a path")).map((r) => r.last);
      expect(told).toHaveLength(2);
      expect(told.filter((t) => t.includes("BUZZ_PRIVATE_KEY="))).toEqual([]);

      // A file named in `files` goes up with a message whose words start with a slash, posted as written, and
      // a file the CLI writes comes back among the coworker's.
      const SHARED = "/rent-roll: the 4B rent roll, from /duck/home/report-4B.txt";
      firm.model.on(
        all(main, said("Share the 4B report in harbor-ops.")),
        call("shell", { command: "printf 'Rent roll for 4B' > /duck/home/report-4B.txt" }),
      );
      firm.model.on(
        all(main, answered("shell")),
        call(TOOLS.buzz, {
          args: ["messages", "send", "--channel", channel, "--file", "report-4B.txt", "--content", "-"],
          input: SHARED,
          files: ["/duck/home/report-4B.txt"],
        }),
      );
      firm.model.on(printed("event_id"), say("Shared."));
      await buzz.person.send("Share the 4B report in harbor-ops.");
      expect(await answer("Shared.")).toBe(true);
      // The words are read as given; what Buzz's CLI adds after them for the file is not.
      const shared = (await buzz.inHarborOps("theo")).findLast((m) => m.tags.some((t) => t[0] === "imeta"));
      expect(shared?.content).toStartWith(SHARED);
      const url = String(
        shared?.tags
          .find((t) => t[0] === "imeta")
          ?.find((e) => e.startsWith("url "))
          ?.slice(4),
      );
      expect((await buzz.person.file(url)).toString()).toBe("Rent roll for 4B");
      firm.model.on(
        all(main, said("Fetch the 4B report back from Buzz.")),
        call(TOOLS.buzz, { args: ["media", "get", url, "-o", "copy-4B.txt"] }),
      );
      firm.model.on(
        printed("/duck/home/plugs/buzz/copy-4B.txt"),
        call("shell", { command: "cat /duck/home/plugs/buzz/copy-4B.txt" }),
      );
      firm.model.on(all(main, answered("shell"), said("Rent roll for 4B")), say("Fetched."));
      await buzz.person.send("Fetch the 4B report back from Buzz.");
      expect(await answer("Fetched.")).toBe(true);

      // A file is saved only where the gate names it: a link the coworker put at the name is passed over for
      // the next name, and a folder of saved files that is a link out of the home takes none.
      const own = join(firm.folder, "storage", harbor.coworker);
      firm.model.on(
        all(main, said("Fetch the 4B report again.")),
        call("shell", { command: "ln -s ../../../files/dangle-4B.txt /duck/home/plugs/buzz/again-4B.txt" }),
      );
      firm.model.on(
        all(main, answered("shell")),
        call(TOOLS.buzz, { args: ["media", "get", url, "-o", "again-4B.txt"] }),
      );
      firm.model.on(printed("/duck/home/plugs/buzz/again-4B-2.txt"), say("Fetched again."));
      await buzz.person.send("Fetch the 4B report again.");
      expect(await answer("Fetched again.")).toBe(true);
      expect(readFileSync(join(own, "home", "plugs", "buzz", "again-4B-2.txt"), "utf8")).toBe(
        "Rent roll for 4B",
      );
      expect(existsSync(join(own, "files", "dangle-4B.txt"))).toBe(false);
      firm.model.on(
        all(main, said("Fetch the 4B report into a new folder.")),
        call("shell", {
          command:
            "mv /duck/home/plugs/buzz /duck/home/plugs/buzz-before && ln -s ../../files /duck/home/plugs/buzz",
        }),
      );
      firm.model.on(
        all(main, answered("shell")),
        call(TOOLS.buzz, { args: ["media", "get", url, "-o", "planted-4B.txt"] }),
      );
      firm.model.on(printed("did not save"), say("It was not saved."));
      await buzz.person.send("Fetch the 4B report into a new folder.");
      expect(await answer("It was not saved.")).toBe(true);
      expect(existsSync(join(own, "files", "planted-4B.txt"))).toBe(false);

      // A delete asks first, and runs once on the person's yes, which duck reads.
      firm.model.on(
        all(main, said("Take your rent roll ask out of harbor-ops.")),
        call(TOOLS.buzz, { args: ["messages", "delete", "--event", asked] }),
      );
      firm.model.on(all(main, answered(TOOLS.buzz)), say("I've asked you first."));
      firm.model.on(all(reading, said("Yes, take it out.")), say("yes"));

      firm.model.on(main, say("Done."), { times: Number.POSITIVE_INFINITY });
      await buzz.person.send("Take your rent roll ask out of harbor-ops.");
      const question = [(await buzz.person.next(60)).content, (await buzz.person.next(60)).content];
      expect(question.some((t) => t.includes("Your yes is needed for duck's buzz"))).toBe(true);
      expect((await buzz.inHarborOps("theo")).some((m) => m.id === asked)).toBe(true);
      await buzz.person.send("Yes, take it out.");
      for (let waited = 0; (await buzz.inHarborOps("theo")).some((m) => m.id === asked); waited++) {
        if (waited === 120) throw new Error("waited 60 s for the message out of harbor-ops");
        firm.trouble.check();
        await Bun.sleep(500);
      }
      firm.trouble.check();
    },
    E2E,
  );

  test(
    "the coworker's own question, sent with buzz into the person's DM after a held call was asked, is kept as a message to her and shown to the decision model between the question and her reply, which is read at the time Buzz gives it",
    async () => {
      const main = (r: ModelRequest) => r.has(TOOLS.writeItem) && !r.has(TOOLS.tell);
      const printed = (text: string) => all(main, answered(TOOLS.buzz), said(text));
      // The delete's outcome can reach the main conversation after the step before has ended, under its rules.
      await until(
        "the delete's outcome told",
        () => firm.model.requests.some(all(main, said('"answer":"yes"'))),
        60,
        firm.trouble,
      );
      firm.model.clear();
      const [ARCHIVE, MORE, QUESTION, YES] = [
        "Archive harbor-ops.",
        "Anything else before you do?",
        "Shall I also archive harbor-lease? Reply yes.",
        "Yes!",
      ];
      firm.model.on(
        all(main, said(ARCHIVE)),
        call(TOOLS.buzz, { args: ["channels", "archive", "--channel", buzz.channel] }),
      );
      firm.model.on(all(main, answered(TOOLS.buzz)), say("I've asked you first."));
      firm.model.on(
        all(main, said(MORE)),
        call(TOOLS.buzz, { args: ["dms", "open", "--pubkey", buzz.keys.rosa] }),
      );
      firm.model.on(printed("dm_id"), (r) =>
        call(TOOLS.buzz, {
          args: [
            "messages",
            "send",
            "--channel",
            /"dm_id":\s*"([0-9a-f-]{36})"/.exec(r.last)?.[1] ?? "",
            "--content",
            "-",
          ],
          input: QUESTION,
        }),
      );
      firm.model.on(printed("event_id"), say("I've asked you something in our DM."));
      firm.model.on(reading, say("neither"), { times: Number.POSITIVE_INFINITY });
      firm.model.on(all(main, said(YES)), say("Noted."));

      await buzz.person.send(ARCHIVE);
      // What the run before left on its way to her comes first.
      let question = "";
      while (!question.includes("Your yes is needed")) question = (await buzz.person.next(60)).content;
      expect(question).toContain('["channels","archive"');
      await buzz.person.send(MORE);
      for (let seen = ""; !seen.includes("in our DM"); ) seen = (await buzz.person.next(60)).content;
      await buzz.person.send(YES);
      await until(
        "her yes read and answered",
        () => firm.model.requests.some(all(main, said(YES))),
        60,
        firm.trouble,
      );

      const shown = firm.model.requests.find(all(reading, said(YES)))?.read?.conversation ?? [];
      const entry = (text: string) => shown.findIndex((e) => e.text === text);
      expect(shown[entry(question)]?.from).toBe("duck's question");
      expect(shown[entry(QUESTION)]?.from).toBe("the coworker");
      expect(entry(question)).toBeLessThan(entry(QUESTION));
      expect(shown.at(-1)).toMatchObject({
        from: "the person",
        text: YES,
        at: expect.stringMatching(/\.000Z$/),
      });
      const db = firm.db();
      const open = db.query("select answer from outbox where kind = 'ask' order by id desc limit 1").all();
      db.close();
      expect(open).toEqual([{ answer: null }]);
      firm.trouble.check();
    },
    E2E,
  );

  test(
    "the coworker's message in a channel thread where the person wrote is kept as a message to her, and the decision model is shown it, marked as the coworker's, ahead of the question that followed it there",
    async () => {
      firm.model.clear();
      const main = (r: ModelRequest) => r.has(TOOLS.writeItem) && !r.has(TOOLS.tell);
      const printed = (text: string) => all(main, answered(TOOLS.buzz), said(text));
      const [CLEAN, BEFORE, YES] = [
        "Clean up harbor-ops when you can.",
        "Before I take my note down: shall I tell Theo first?",
        "Yes, go on.",
      ];
      // Her message's id is known once Buzz's CLI has sent it, which can be after the coworker's run asks the
      // model, so the reply waits for it.
      const sent = Promise.withResolvers<string>();
      firm.model.on(all(main, said(CLEAN)), async () =>
        call(TOOLS.buzz, {
          args: ["messages", "send", "--channel", buzz.channel, "--reply-to", await sent.promise, "--content", "-"],
          input: BEFORE,
        }),
      );
      // A delete of that very message, so its question is told apart from the one the step before left open.
      firm.model.on(printed("event_id"), (r) =>
        call(TOOLS.buzz, {
          args: ["messages", "delete", "--event", /"event_id":\s*"([0-9a-f]{64})"/.exec(r.last)?.[1] ?? ""],
        }),
      );
      firm.model.on(printed("The gate holds"), say("I've asked you first."));
      firm.model.on(reading, say("neither"), { times: Number.POSITIVE_INFINITY });
      firm.model.on(all(main, said(YES)), say("Noted."));

      const root = (await buzz.write("rosa", "harbor-ops", CLEAN)).id;
      sent.resolve(root);
      let question = "";
      for (let waited = 0; !question; waited++) {
        if (waited === 120) throw new Error("waited 60 s for the question in the thread");
        firm.trouble.check();
        await Bun.sleep(500);
        const thread = await buzz.thread(root);
        question = thread.find((m) => m.content.includes("Your yes is needed"))?.content ?? "";
      }
      await buzz.write("rosa", "harbor-ops", YES, { reply: root });
      await until(
        "her yes read and handed on",
        () => firm.model.requests.some(all(main, said(YES))),
        60,
        firm.trouble,
      );

      const read = firm.model.requests.find(
        (r) =>
          reading(r) &&
          said(YES)(r) &&
          !!r.read?.questions.some((q) => r.read?.conversation[q.entry - 1]?.text === question),
      );
      const shown = read?.read?.conversation ?? [];
      const entry = (text: string) => shown.findIndex((e) => e.text === text);
      expect(shown[entry(BEFORE)]?.from).toBe("the coworker");
      expect(shown[entry(question)]?.from).toBe("duck's question");
      expect(entry(BEFORE)).toBeLessThan(entry(question));
      expect(shown.at(-1)).toMatchObject({ from: "the person", text: YES });
      firm.trouble.check();
    },
    E2E,
  );

  test(
    "a DM the person writes while duck is stopped is answered once it starts again, and the one answered before it stopped is not answered again",
    async () => {
      firm.model.clear();
      const main = (r: ModelRequest) => r.has(TOOLS.writeItem) && !r.has(TOOLS.tell);
      const [BEFORE, ANSWERED, WHILE, LATER] = [
        "What does 4B pay a month?",
        "4B pays $2,400 a month.",
        "And what does 5C pay?",
        "5C pays $2,100 a month.",
      ];
      // The questions the steps before left open are each read against what she writes.
      firm.model.on(reading, say("neither"), { times: Number.POSITIVE_INFINITY });
      firm.model.on(all(main, said(BEFORE)), say(ANSWERED));
      firm.model.on(all(main, said(WHILE)), say(LATER));

      await buzz.person.send(BEFORE);
      await buzz.inDm("rosa", buzz.keys.wren, ANSWERED, 60);
      await firm.stop();
      await buzz.person.send(WHILE);
      // Longer than the 5 s buzz-acp looks back from its own start, so her message is older than that look.
      await Bun.sleep(8_000);
      await firm.start();

      await buzz.inDm("rosa", buzz.keys.wren, LATER, 120);
      const answers = (await buzz.dmOf("rosa")).map((m) => m.content);
      expect([ANSWERED, LATER].map((t) => answers.filter((a) => a === t).length)).toEqual([1, 1]);
      expect(firm.model.requests.filter(all(main, said(BEFORE)))).toHaveLength(1);
      firm.trouble.check();
    },
    E2E,
  );
});

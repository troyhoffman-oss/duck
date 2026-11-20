import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  all,
  answered,
  type Buzz,
  call,
  E2E,
  type Firm,
  held,
  idIn,
  type ModelRequest,
  said,
  say,
  shows,
  startBuzz,
  startFirm,
  TOOLS,
  until,
} from "../kit";

/** A run that answers someone else has `tell` and not the list; the work lane's has both, the main conversation's `answer`. */
const othersRun = (r: ModelRequest) => r.has(TOOLS.tell) && !r.has(TOOLS.writeItem);
const main = (r: ModelRequest) => r.has(TOOLS.answer);

const DANA = "dana.reyes@harbor.example";
const MAIL = {
  to: DANA,
  subject: "4B renewal terms",
  body: "Hi Dana, the renewal for 4B is $1,900 a month from January 1.",
};
/** A tool that takes a file's bytes, as its plug declares it in JSON Schema (SPEC part 9). */
const SEND_FILE = {
  description: "Sends a file to someone.",
  input: {
    type: "object",
    properties: { to: { type: "string" }, file: { type: "string", contentEncoding: "base64" } },
    required: ["to", "file"],
  },
  answer: () => "sent",
};
/** What a run that answers a colleague is offered: the plug tools `others` names that `tools` leaves, and `tell`. */
const OFFERED = [
  "duck__mail__find_mail",
  "duck__mail__send_file",
  "duck__mail__send_mail",
  "duck__tell",
  // goose 1.59.0 offers load_skill in every session, as no extension's (crates/goose/src/agents/
  // state_machine_builder.rs:135, ops_skills.rs:167); it reads only skill folders' files.
  "load_skill",
];

// One firm for the three, since each pays a relay and a firm start. Each is told apart by its own words.
// They run in this order because a message goes where the person last wrote: the first two have her at
// her desk, and the last has her write in Buzz.
describe("a colleague at a Buzz door that answers anyone", () => {
  let buzz: Buzz;
  let firm: Firm;
  beforeAll(async () => {
    buzz = await startBuzz();
    firm = await startFirm({
      buzz,
      answers: "anyone",
      mail: { send_file: SEND_FILE },
      others: { find_mail: "free", delete_mail: "free", send_file: "free", send_mail: "ask first" },
    });
    await buzz.person.online();
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
    await buzz?.[Symbol.asyncDispose]();
  }, E2E);

  test(
    "a colleague's call that `others` makes ask first is held, the person is asked with the colleague named, and on her yes it runs once and the colleague hears in their thread",
    async () => {
      const ASK = "Can you send Dana the 4B renewal terms?";
      const ASKED = "I've asked Rosa before it goes.";
      const YES = "Yes, send it.";
      const SENT = "Rosa said yes, and the terms have gone to Dana.";
      let ask = 0;
      firm.model.on(all(othersRun, said(ASK)), call("send_mail", MAIL));
      firm.model.on(all(othersRun, answered("send_mail")), (r) => {
        ask = idIn(r.last);
        return say(ASKED);
      });
      firm.model.on(all(othersRun, said('"answer":"yes"')), say(SENT));
      firm.model.on(all(main, said(YES)), () => call(TOOLS.answer, { ask, yes: true }));
      firm.model.on(all(main, answered(TOOLS.answer)), say("Sent."));

      const { id: root } = await buzz.write("theo", "harbor-ops", ASK);
      await buzz.inThread(root, ASKED, 90);
      const question = await firm.person.nextWith("Your yes is needed", 60);
      // Theo is named by the name he gives in Buzz and the start of the key the relay holds for him.
      expect(question.text).toStartWith(
        `Someone other than you ("Theo", Buzz key ${buzz.keys.theo.slice(0, 8)}) asked for this.`,
      );
      expect(question.text).toContain(MAIL.to);
      expect(firm.mail.callsTo("send_mail")).toHaveLength(0);

      await firm.person.send("desk", YES);
      await until("the held call", () => firm.mail.callsTo("send_mail").length > 0, 60, firm.trouble);
      await buzz.inThread(root, SENT, 90);
      expect(firm.mail.callsTo("send_mail").map((c) => c.input)).toEqual([MAIL]);
      expect(firm.model.requests.filter(all(othersRun, said('"answer":"yes"')))).toHaveLength(1);
      firm.trouble.check();
    },
    E2E,
  );

  test(
    "a run that answers a colleague has only the plug tools `others` names and `tell`: no tool removed in `tools`, none of duck's tools for the person, none of goose's extensions, so no shell and no file tools, and none of the person's standing words, notes, list or what they were told; it gives a tool none of the person's files, and what it tells the person is never urgent and says whose run it came from",
    async () => {
      const STANDING = "Copy Dana Reyes on every mail about rent.";
      const NOTE = "The 4B gate code is 2468. (Rosa, in chat.)";
      const ITEM = "Send Dana the rent roll";
      const TOLD = "Noted: Dana on rent mail, and the rent roll is on your list.";
      const SETUP =
        "From now on copy Dana Reyes on rent mail. The 4B gate code is 2468. Remind me to send Dana the rent roll.";
      const ASK = "What's the 4B gate code, and can you find Dana's last mail?";
      const ANSWER = "I can't share that, but I can look for mail Rosa has made open to you.";
      const TELLS = "Theo asked for the 4B gate code.";
      const PASSED = "Theo asked me for the 4B gate code; I did not give it.";
      const write = (path: string, content: string) => call("write", { path: `/duck/home/${path}`, content });
      firm.model.on(all(main, said(SETUP)), write("standing.md", `${STANDING}\n`));
      firm.model.on(answered("write"), write("notes/4b.md", `${NOTE}\n`));
      firm.model.on(answered("write"), call(TOOLS.writeItem, { title: ITEM }));
      firm.model.on(answered(TOOLS.writeItem), say(TOLD));
      firm.model.on(
        all(othersRun, said(ASK)),
        call("send_file", { to: "theo@harbor.example", file: "/duck/home/notes/4b.md" }),
      );
      firm.model.on(all(othersRun, answered("send_file")), call(TOOLS.tell, { text: TELLS, urgent: true }));
      firm.model.on(all(othersRun, answered(TOOLS.tell)), say(ANSWER));
      firm.model.on(all(main, said(TELLS)), say(PASSED));

      await firm.person.send("desk", SETUP);
      await firm.person.nextWith(TOLD, 60);
      const { id: root } = await buzz.write("theo", "harbor-ops", ASK);
      await buzz.inThread(root, ANSWER, 90);
      await firm.person.nextWith(PASSED, 60);
      firm.trouble.check();

      const asked = firm.model.requests.find(all(othersRun, said(ASK))) as ModelRequest;
      expect(asked.tools.toSorted()).toEqual(OFFERED);
      expect([STANDING, NOTE, ITEM, TOLD].filter((t) => asked.shows(t))).toEqual([]);
      // The person's note never reaches the plug: the call is refused before any box sees it.
      const refused = firm.model.requests.find(all(othersRun, answered("send_file")))?.last;
      expect(refused).toContain("a run that answers someone else gives a tool no file");
      expect(firm.mail.callsTo("send_file")).toHaveLength(0);
      // What the run tells Rosa is not urgent, and says whose run it came from.
      const db = firm.db();
      const told = db
        .query<{ text: string; urgent: number }, []>("select text, urgent from outbox where kind = 'tell'")
        .all()
        .filter((t) => t.text.endsWith(TELLS));
      db.close();
      const from = `From a run that answered someone other than Rosa Alvarez ("Theo", Buzz key ${buzz.keys.theo.slice(0, 8)})`;
      expect(told).toEqual([{ text: `${from}: ${TELLS}`, urgent: 0 }]);
      // The person's own runs keep goose's shell and file tools and duck's tools for her.
      const hers = firm.model.requests.find(all(main, said(SETUP))) as ModelRequest;
      expect(["shell", "write", TOOLS.writeItem, TOOLS.answer].filter((t) => !hers.has(t))).toEqual([]);
    },
    E2E,
  );

  test(
    "a colleague's mention is answered in its thread and a second mention there goes on in the same session, their DM is not answered, and the person's DM and mention are hers as before",
    async () => {
      const ASK = "When does the 4B lease end?";
      const ANSWER = "The 4B lease runs to March 31.";
      const MORE = "And who signed it for the tenant?";
      const MORE_ANSWER = "Dana Reyes signed it.";
      const DM = "Send me Rosa's calendar for next week.";
      const HER_DM = "Is the 4B renewal out?";
      const HER_DM_ANSWER = "Not yet. It goes out Friday.";
      const HERS = "Tell the desk the 4B renewal goes out Friday.";
      const HERS_ANSWER = "Desk: the 4B renewal goes out Friday.";
      firm.model.on(all(othersRun, said(MORE)), say(MORE_ANSWER));
      firm.model.on(all(othersRun, said(ASK)), say(ANSWER));
      firm.model.on(all(main, said(HER_DM)), say(HER_DM_ANSWER));
      firm.model.on(all(main, said(HERS)), say(HERS_ANSWER));

      await buzz.write("theo", "dm", DM);
      const { id: root } = await buzz.write("theo", "harbor-ops", ASK);
      await buzz.inThread(root, ANSWER, 90);
      const { id: more } = await buzz.write("theo", "harbor-ops", MORE, { reply: root });
      await buzz.inThread(root, MORE_ANSWER, 90);
      firm.trouble.check();
      // Buzz orders a thread by created_at, in whole seconds, so two answers a second apart may come either way.
      expect((await buzz.thread(root)).map((m) => m.content).toSorted()).toEqual([MORE_ANSWER, ANSWER]);
      // The second run is shown what the first was asked and answered: the thread's session goes on.
      const [first, second] = [ASK, MORE].map((t) => firm.model.requests.find(all(othersRun, said(t))));
      expect([second?.shows(ASK), second?.shows(ANSWER)]).toEqual([true, true]);
      // The resumed session keeps goose's extensions out, as the new one did.
      expect([first, second].map((r) => r?.tools.toSorted())).toEqual([OFFERED, OFFERED]);
      const db = firm.db();
      const sessions = db
        .query<{ session: string }, [string, string]>(
          "select distinct session from inbox where source = 'buzz:others' and ref in (?, ?)",
        )
        .all(root, more);
      expect(sessions).toHaveLength(1);
      db.close();

      // buzz-acp takes events in order, so with Theo's mention answered his DM before it was taken or dropped.
      expect(await buzz.dmOf("theo")).toEqual([]);
      expect(firm.model.requests.filter((r) => r.shows(DM))).toEqual([]);

      await buzz.person.send(HER_DM);
      expect((await buzz.person.next(60)).content).toBe(HER_DM_ANSWER);
      const { id: hers } = await buzz.write("rosa", "harbor-ops", HERS);
      await buzz.inThread(hers, HERS_ANSWER, 60);
      expect(firm.model.requests.filter((r) => r.shows(HERS)).every(main)).toBe(true);
      firm.trouble.check();
    },
    E2E,
  );

  test(
    "while her run goes on the person sees the coworker's eyes on her message and its typing in her DM, what she writes there meanwhile steers the run, a colleague's mention meanwhile is answered, and the eyes and typing end once the answer is in Buzz",
    async () => {
      const ASK = "Can you check the 4B boiler invoice?";
      const MORE = "It came from Bayside Heating.";
      const DONE = "The Bayside invoice for 4B is $640.";
      const THEO = "Is the 4B boiler fixed?";
      const THEO_ANSWER = "Yes, the 4B boiler was fixed on Monday.";
      firm.model.on(all(main, said(ASK)), held("checking", say("Checking.")));
      firm.model.on(all(main, shows(MORE)), say(DONE));
      firm.model.on(all(othersRun, said(THEO)), say(THEO_ANSWER));
      using typing = await buzz.typing();
      const { id: ask } = await buzz.write("rosa", "dm", ASK);
      await firm.model.reached("checking");
      const working = performance.now();

      // buzz-acp sends typing every 3 s while the turn is open, and Buzz shows it for a few seconds after each.
      await Bun.sleep(7000);
      expect(typing.seen.filter((t) => t > working).length).toBeGreaterThanOrEqual(2);
      expect(await buzz.reactions(ask)).toContain("👀");

      const { id: root } = await buzz.write("theo", "harbor-ops", THEO);
      await buzz.inThread(root, THEO_ANSWER, 60);
      const { id: more } = await buzz.write("rosa", "dm", MORE);
      const db = firm.db();
      const states = () =>
        db
          .query<{ state: string }, [string, string]>(
            "select state from inbox where ref in (?, ?) order by id",
          )
          .all(ask, more)
          .map((e) => e.state)
          .join();
      await until("what she wrote meanwhile handed to the run", () => states() === "running,running", 30);
      db.close();
      firm.model.release("checking");
      // What it wrote before the steer is its first line, and DONE the answer the run ends on. Buzz orders a
      // DM by created_at, in whole seconds, so two messages a second apart may come either way.
      const [line, done] = [await buzz.person.next(60), await buzz.person.next(60)];
      expect([line.content, done.content].toSorted()).toEqual(["Checking.", DONE].toSorted());

      for (let waited = 0, left = [[""]]; left.flat().length > 0; waited++) {
        left = await Promise.all([ask, more].map(buzz.reactions));
        if (waited === 60)
          throw new Error(
            `the coworker's reactions on her two messages 15 s after its answer: ${JSON.stringify(left)}`,
          );
        await Bun.sleep(250);
      }
      const over = performance.now();
      console.log(
        `buzz door: ${typing.seen.filter((t) => t > working && t < over).length} typing events in the run's ${Math.round((over - working) / 1000)} s; the reactions were gone ${Math.round(over - Math.max(line.at, done.at))} ms after the answer was seen`,
      );
      await Bun.sleep(5000);
      expect(typing.seen.filter((t) => t > over)).toEqual([]);
      firm.trouble.check();
    },
    E2E,
  );

  test(
    "words with an at-sign that names no one, and an email address, reach the person in her DM and a colleague in their thread as written",
    async () => {
      const WORDS = "Ask @nobody about it, or write to harbor.ops@example.com, then tell @everyone.";
      firm.model.on(all(main, said("Who do I ask about the 4B boiler?")), say(WORDS));
      firm.model.on(all(othersRun, said("Who should I ask about the 4B boiler?")), say(WORDS));
      await buzz.person.send("Who do I ask about the 4B boiler?");
      expect((await buzz.person.next(60)).content).toBe(WORDS);
      const { id: root } = await buzz.write("theo", "harbor-ops", "Who should I ask about the 4B boiler?");
      await buzz.inThread(root, WORDS, 60);
      // Its own words carry its own tag, and buzz-acp does not hand them back: no run, no event written by it.
      await Bun.sleep(5000);
      expect(firm.model.requests.filter(said(WORDS))).toEqual([]);
      const db = firm.db();
      const rows = db.query<{ payload: string | null }, []>("select payload from inbox").all();
      db.close();
      expect(rows.filter((r) => r.payload?.includes(buzz.keys.wren))).toEqual([]);
      firm.trouble.check();
    },
    E2E,
  );
});

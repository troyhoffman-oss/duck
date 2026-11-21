import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  all,
  answered,
  type Buzz,
  call,
  E2E,
  type Firm,
  held,
  idIn,
  jobRun,
  loadPlugin,
  reading,
  said,
  say,
  second,
  shows,
  sorter,
  startBuzz,
  startFirm,
  TOOLS,
  team,
} from "../kit";
import type { When } from "../kit/model";

setDefaultTimeout(E2E);

/** A run of coworker `name`: its harness names it. */
const of = (name: string): When => shows(`You are ${name},`);
const tally = of(team.coworker);
const finch = of(second.coworker);
/** A run in `who`'s main conversation: it has the list, and only a run outside it has `tell` (SPEC part 10). */
const main = (who: When): When => all(who, (r) => r.has(TOOLS.writeItem) && !r.has(TOOLS.tell));

const MAIL = {
  to: "dana.reyes@harbor.example",
  subject: "4B renewal terms",
  body: "Hi Dana, the renewal for 4B is $1,900 a month from January 1.",
};

/** Waits up to `seconds` for `check` to hold, asking again every 250 ms. */
async function until(what: string, check: () => Promise<boolean>, seconds: number) {
  for (const end = Date.now() + seconds * 1000; !(await check()); await Bun.sleep(250))
    if (Date.now() > end) throw new Error(`waited ${seconds} s for ${what}`);
}

// A team coworker (SPEC part 14): tally, the firm's accountant, made for Rosa with harbor-ops as its team's
// channel. Theo and Ana are people at the firm, and Finch is Theo's own coworker. One relay and one firm for
// every step; the steps run in order, each going on from the last.
describe("the firm's accountant takes requests from anyone in harbor-ops", () => {
  let buzz: Buzz;
  let firm: Firm;
  let key = "";
  beforeAll(async () => {
    buzz = await startBuzz();
    firm = await startFirm({ buzz, second: true, team: true });
    key = firm.teamKey;
    await buzz.person.online(240, key);
    await buzz.person.online(240, firm.secondKey);
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
    await buzz?.[Symbol.asyncDispose]();
  }, E2E);
  afterEach(() => firm.step(), E2E);

  /** The lines code wrote on the log of tally's item titled `title` (SPEC part 7). */
  const codeLog = (title: string) => {
    using db = firm.db(team.coworker);
    return db
      .query<{ text: string }, [string]>(
        "select log.text from log join items on items.id = log.item_id where items.title = ? and log.by = 'code'",
      )
      .all(title)
      .map((l) => l.text);
  };

  /** The tools a request another coworker makes is not given: the jobs' and the timers'. */
  const UNGIVEN = [TOOLS.startJob, "jobs", "note_job", "stop_job", TOOLS.setTimer, TOOLS.removeTimer];
  /** What tally's run of request `text` was given that a coworker's request is not: in this firm, no plug tool. */
  const beyond = (text: string) => {
    const run = firm.model.requests.find(all(tally, said(text)));
    if (!run) throw new Error(`tally had no run of "${text}"`);
    const plugs = run.tools.filter((t) => /(^|__)mail__/.test(t) && !t.endsWith("__connect"));
    return [...UNGIVEN.filter((name) => run.has(name)), ...plugs];
  };
  /** Finch's message to tally in harbor-ops, under event `reply` if given. */
  const toTally = (input: string, reply?: string) => {
    const under = reply ? ["--reply-to", reply] : [];
    const to = ["--channel", buzz.channel, ...under, "--mention", key];
    return call(TOOLS.buzz, { args: ["messages", "send", ...to, "--content", "-"], input });
  };

  test("Theo mentions tally in harbor-ops and gets its answer in his thread, from a run with its own notes, list and tools, and his second question there goes on from the first", async () => {
    const ASK = "What did we pay for the 4B boiler repair?";
    const ANSWER = "The 4B boiler repair was $640, paid on November 3.";
    const MORE = "Which account did it come out of?";
    const MORE_ANSWER = "It came out of the 4B operating account.";
    firm.model.on(all(tally, said(ASK)), say(ANSWER));
    firm.model.on(all(tally, said(MORE)), say(MORE_ANSWER));

    const { id: root } = await buzz.write("theo", "harbor-ops", ASK, { to: key });
    await buzz.inThread(root, ANSWER, 90, key);
    await buzz.write("theo", "harbor-ops", MORE, { to: key, reply: root });
    await buzz.inThread(root, MORE_ANSWER, 90, key);

    // A request is not an others run: it has the coworker's list and goose's own tools.
    const asked = firm.model.requests.find(all(tally, said(ASK)));
    expect(["shell", TOOLS.writeItem].filter((t) => !asked?.has(t))).toEqual([]);
    // One Buzz thread is one session: the second question's run is shown the first and its answer.
    const more = firm.model.requests.find(all(tally, said(MORE)));
    expect([more?.shows(ASK), more?.shows(ANSWER)]).toEqual([true, true]);
  });

  test("what Theo tells tally, Ana hears when she asks in a thread of her own", async () => {
    const TOLD = "Heads up: Bayside Heating serviced the 4B boiler on Monday.";
    const NOTE = "4B boiler: serviced by Bayside Heating on Monday (Theo, in harbor-ops).";
    const NOTED = "Noted.";
    const ASK = "Who last serviced the 4B boiler?";
    const ANSWER = "Bayside Heating serviced it on Monday.";
    firm.model.on(
      all(tally, said(TOLD)),
      call("write", { path: "/duck/home/notes/4b-boiler.md", content: `${NOTE}\n` }),
    );
    firm.model.on(all(tally, answered("write")), say(NOTED));
    firm.model.on(all(tally, said(ASK), shows(NOTE)), say(ANSWER));

    const { id: theo } = await buzz.write("theo", "harbor-ops", TOLD, { to: key });
    await buzz.inThread(theo, NOTED, 90, key);
    const { id: ana } = await buzz.write("ana", "harbor-ops", ASK, { to: key });
    await buzz.inThread(ana, ANSWER, 90, key);
  });

  test("Theo's request becomes an item on tally's list that says Theo asked, and Rosa sees it in tally's To-dos", async () => {
    const ASK = "Please reconcile the October rent roll for 4B.";
    const TITLE = "4B: reconcile the October rent roll";
    const ON_IT = "On it: the October rent roll for 4B is on my list.";
    firm.model.on(all(tally, said(ASK)), call(TOOLS.writeItem, { title: TITLE }));
    firm.model.on(all(tally, answered(TOOLS.writeItem)), say(ON_IT));

    const { id: root } = await buzz.write("theo", "harbor-ops", ASK, { to: key });
    await buzz.inThread(root, ON_IT, 90, key);
    const asker = `"Theo", Buzz key ${buzz.keys.theo.slice(0, 8)}`;
    expect(codeLog(TITLE).filter((l) => l.includes(asker))).toHaveLength(1);

    const plugin = await loadPlugin(buzz, "rosa");
    const shown = await plugin.tab("To-dos", key, (l) => l.includes(TITLE));
    expect(shown.lines).toContain(TITLE);
  });

  test("a long request from Ana starts a job, Theo's question meanwhile is answered before the job ends, and the job's result arrives in Ana's thread", async () => {
    const ASK = "Please put together this year's 4B expense summary.";
    const STARTED = "I've started on it and will post the summary here.";
    const BRIEF = "Sum 4B's expenses this year by category. Done means: a total and the boiler's share.";
    const REPORT =
      "Blocked on me: nothing. Changed: nothing. Found: 4B spent $8,420 this year, $640 of it on the boiler.";
    const RESULT = "4B spent $8,420 this year; $640 of it was the boiler repair.";
    const QUICK = "Is the Bayside invoice for 4B paid?";
    const PAID = "Yes, the Bayside invoice was paid on November 3.";
    firm.model.on(all(tally, said(ASK)), call(TOOLS.writeItem, { title: "4B: this year's expense summary" }));
    firm.model.on(all(tally, answered(TOOLS.writeItem)), (r) =>
      call(TOOLS.startJob, {
        item_id: idIn(r.last),
        title: "4B expense summary",
        brief: BRIEF,
        check: false,
        check_reason: "Ana reads the summary herself.",
      }),
    );
    firm.model.on(all(tally, answered(TOOLS.startJob)), say(STARTED));
    firm.model.on(all(jobRun, shows(BRIEF)), held("summary", say(REPORT)));
    firm.model.on(all(tally, said(QUICK)), say(PAID));
    firm.model.on(all(tally, said("$8,420")), say(RESULT));

    const { id: ana } = await buzz.write("ana", "harbor-ops", ASK, { to: key });
    await buzz.inThread(ana, STARTED, 90, key);
    await firm.model.reached("summary");
    const { id: theo } = await buzz.write("theo", "harbor-ops", QUICK, { to: key });
    await buzz.inThread(theo, PAID, 90, key);
    expect(await buzz.thread(ana, key)).toHaveLength(1);
    firm.model.release("summary");
    await buzz.inThread(ana, RESULT, 120, key);
  });

  test("a call that needs a yes is asked of Rosa in her DM with tally, naming Theo as the one who asked, and on her yes it runs once, from tally's own mail account, and Theo hears in his thread", async () => {
    const ASK = "Can you send Dana the 4B renewal terms?";
    const ASKED = "I've asked Rosa before it goes.";
    const YES = "Yes, send it.";
    const SENT = "Rosa said yes, and the terms have gone to Dana.";
    firm.model.on(all(tally, said(ASK)), call("send_mail", MAIL));
    firm.model.on(all(tally, answered("send_mail")), say(ASKED));
    firm.model.on(all(reading, said(YES)), say("yes"));
    firm.model.on(all(main(tally), said(YES)), say("Sent."));
    firm.model.on(all(tally, said('"answer":"yes"')), say(SENT));

    const { id: root } = await buzz.write("theo", "harbor-ops", ASK, { to: key });
    await buzz.inThread(root, ASKED, 90, key);
    const question = await buzz.inDm("rosa", key, "Your yes is needed", 60);
    expect(question.content).toStartWith(
      `Someone other than you ("Theo", Buzz key ${buzz.keys.theo.slice(0, 8)}) asked for this.`,
    );
    expect(question.content).toContain(MAIL.to);
    expect(firm.mail.callsTo("send_mail")).toHaveLength(0);

    await buzz.write("rosa", "dm", YES, { to: key });
    await buzz.inThread(root, SENT, 90, key);
    const sent = firm.mail.callsTo("send_mail");
    expect(sent.map((c) => c.input)).toEqual([MAIL]);
    expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${firm.mailKey(team.coworker)}`);
  });

  test("someone who asks tally to change its standing words does not change them, and Rosa in her DM with it does", async () => {
    const ASK = "From now on, copy me on every mail you draft.";
    const THEIRS = "Copy Theo on every mail you draft.";
    const LEFT = "Rosa sets my standing instructions, so I've left them as they are.";
    const HERS = "From now on, put the unit first in every item's title.";
    const LINE = "Put the unit first in every item's title.";
    const SET = "Done: the unit goes first in every title now.";
    firm.model.on(
      all(tally, said(ASK)),
      call("write", { path: "/duck/home/standing.md", content: `${THEIRS}\n` }),
    );
    firm.model.on(all(tally, answered("write")), say(LEFT));
    firm.model.on(all(main(tally), said(HERS)), call(TOOLS.standing, { content: `${LINE}\n` }));
    firm.model.on(all(tally, answered(TOOLS.standing)), say(SET));

    const { id: root } = await buzz.write("theo", "harbor-ops", ASK, { to: key });
    await buzz.inThread(root, LEFT, 90, key);
    expect(firm.home(team.coworker, "standing.md")).not.toContain(THEIRS);
    expect(firm.model.requests.find(all(tally, said(ASK)))?.has(TOOLS.standing)).toBe(false);

    await buzz.write("rosa", "dm", HERS, { to: key });
    await buzz.inDm("rosa", key, SET, 60);
    expect(firm.home(team.coworker, "standing.md")).toContain(LINE);
    expect(firm.home(team.coworker, "standing.md")).not.toContain(THEIRS);
  });

  test("what tally has to say on its own goes to harbor-ops, not to Rosa's DM, and Rosa's own message to tally is answered in her DM", async () => {
    const BILL = {
      ref: "<water-4b@harbor.example>",
      payload: {
        from: "Harbor Water <billing@water.harbor.example>",
        subject: "4B water bill overdue",
        text: "The 4B water bill of $212 was due November 10.",
      },
      person: team.coworker,
    };
    const TOLD = "The 4B water bill of $212 is overdue since November 10.";
    const POSTED = "Team: the 4B water bill of $212 has been overdue since November 10.";
    const ASK = "Anything else I should know about 4B?";
    const ANSWER = "Only the water bill, which I posted in harbor-ops.";
    firm.model.on(all(sorter, shows(BILL.payload.subject)), say("wake: an overdue bill"));
    firm.model.on(
      all(tally, shows(BILL.payload.subject), (r) => r.has(TOOLS.tell)),
      call(TOOLS.tell, { text: TOLD }),
    );
    firm.model.on(all(tally, answered(TOOLS.tell)), say("Passed on."));
    firm.model.on(all(main(tally), shows(TOLD)), say(POSTED));
    firm.model.on(all(main(tally), said(ASK)), say(ANSWER));

    await firm.push(BILL);
    const inChannel = async () => (await buzz.inHarborOps("theo", key)).some((m) => m.content === POSTED);
    await until(`"${POSTED}" in harbor-ops`, inChannel, 90);
    expect((await buzz.dmOf("rosa", key)).map((m) => m.content)).not.toContain(POSTED);

    await buzz.write("rosa", "dm", ASK, { to: key });
    await buzz.inDm("rosa", key, ANSWER, 60);
  });

  test("Theo's coworker Finch asks tally in harbor-ops on its own, tally's answer comes back to Finch as someone else's words, Theo hears it from Finch, and tally's item says Finch asked for Theo", async () => {
    const ASK = "Ask tally whether the 4B deposit came in.";
    const QUESTION = "@tally did the 4B deposit come in?";
    const ASKING = "I've asked tally in harbor-ops.";
    const TITLE = "4B: confirm the deposit came in";
    const ANSWER = "Yes, the 4B deposit of $1,900 came in on November 2.";
    const TOLD = "tally says the 4B deposit of $1,900 came in on November 2.";
    const args = ["messages", "send", "--channel", buzz.channel, "--mention", key, "--content", "-"];
    firm.model.on(all(main(finch), said(ASK)), call(TOOLS.buzz, { args, input: QUESTION }));
    firm.model.on(all(finch, answered(TOOLS.buzz)), say(ASKING));
    firm.model.on(all(tally, said(QUESTION)), call(TOOLS.writeItem, { title: TITLE }));
    firm.model.on(all(tally, answered(TOOLS.writeItem)), say(ANSWER));
    firm.model.on(all(finch, said(ANSWER)), say(TOLD));

    await firm.second.send("desk", ASK);
    await firm.second.nextWith(ASKING, 60);
    await firm.second.nextWith(TOLD, 120);

    // It reached Finch as what tally wrote, not as Theo's own words. The reply row that marks what Finch sent
    // holds no words.
    using db = firm.db(second.coworker);
    const back = db
      .query<{ payload: string }, []>(
        "select payload from inbox where source = 'buzz:reply' and payload is not null",
      )
      .all()
      .map((e) => JSON.parse(e.payload) as { key?: string; text?: string })
      .filter((p) => p.text === ANSWER);
    expect(back.map((p) => p.key)).toEqual([key]);
    // The item records which coworker asked, and whose it is.
    const [coworker, person] = [firm.secondKey.slice(0, 8), buzz.keys.theo.slice(0, 8)];
    expect(codeLog(TITLE).filter((l) => l.includes(coworker) && l.includes(person))).toHaveLength(1);
    // A coworker asked, so tally's run had its own list and the plugs' tools as their `others` states give them,
    // which in this firm is none, where Theo's own request in step 5 could send mail.
    const asked = firm.model.requests.find(all(tally, said(QUESTION)));
    expect([asked?.has(TOOLS.writeItem), asked?.has("send_mail")]).toEqual([true, false]);
  });

  // Before the step on who may ask, which fails until that is built and leaves Theo's request there unanswered.
  test("a request Finch makes of tally, in a thread Finch starts, in a thread Theo started, or under what tally posted on its own, is given no job or timer tools and of the plugs only what their `others` states give", async () => {
    // A thread Finch starts.
    const [ASK, QUESTION, ANSWER] = [
      "Ask tally what the 4B water bill came to.",
      "@tally what did the 4B water bill come to?",
      "The 4B water bill came to $212.",
    ];
    firm.model.on(all(main(finch), said(ASK)), toTally(QUESTION));
    firm.model.on(all(finch, answered(TOOLS.buzz)), say("I've asked tally."));
    firm.model.on(all(tally, said(QUESTION)), say(ANSWER));
    firm.model.on(all(finch, said(ANSWER)), say(`tally says: ${ANSWER}`));
    await firm.second.send("desk", ASK);
    await firm.second.nextWith(`tally says: ${ANSWER}`, 120);
    expect(beyond(QUESTION)).toEqual([]);

    // A thread Theo started, where tally answered him first, so Finch's request goes on in the session his began.
    const [THEO, FEE, LATER, DUE, ON] = [
      "What is the 4B parking fee?",
      "The 4B parking fee is $75 a month.",
      "In Theo's parking thread, ask tally when the fee is due.",
      "@tally when is the 4B parking fee due?",
      "The 4B parking fee is due on the 1st.",
    ];
    let root = "";
    firm.model.on(all(tally, said(THEO)), say(FEE));
    firm.model.on(all(main(finch), said(LATER)), () => toTally(DUE, root));
    firm.model.on(all(finch, answered(TOOLS.buzz)), say("I've asked tally in your thread."));
    firm.model.on(all(tally, said(DUE)), say(ON));
    firm.model.on(all(finch, said(ON)), say(`tally says: ${ON}`));
    root = (await buzz.write("theo", "harbor-ops", THEO, { to: key })).id;
    await buzz.inThread(root, FEE, 90, key);
    await firm.second.send("desk", LATER);
    await firm.second.nextWith(`tally says: ${ON}`, 120);
    expect(beyond(DUE)).toEqual([]);

    // Under what tally posted in harbor-ops from a run of its own work lane, which Finch's reply goes on in.
    const METER = {
      ref: "<gas-4b@harbor.example>",
      payload: {
        from: "Harbor Gas <meters@gas.harbor.example>",
        subject: "4B gas meter reading due",
        text: "The 4B gas meter reading is due by November 30.",
      },
      person: team.coworker,
    };
    const [POSTED, ASKED, WHO] = [
      "Team: the 4B gas meter reading is due by November 30.",
      "Reply to tally's gas meter post and ask who reads the meter.",
      "@tally who reads the 4B gas meter?",
    ];
    let post = "";
    firm.model.on(all(sorter, shows(METER.payload.subject)), say("wake: a reading due"));
    firm.model.on(
      all(tally, shows(METER.payload.subject), (r) => r.has(TOOLS.tell)),
      call(TOOLS.buzz, {
        args: ["messages", "send", "--channel", buzz.channel, "--content", "-"],
        input: POSTED,
      }),
    );
    firm.model.on(all(tally, answered(TOOLS.buzz)), say("Posted."));
    firm.model.on(all(main(finch), said(ASKED)), () => toTally(WHO, post));
    firm.model.on(all(finch, answered(TOOLS.buzz)), say("I've asked tally under its post."));
    firm.model.on(all(tally, said(WHO)), say("Noted."));
    await firm.push(METER);
    const posted = async () => {
      post = (await buzz.inHarborOps("theo", key)).find((m) => m.content === POSTED)?.id ?? "";
      return post !== "";
    };
    await until(`"${POSTED}" in harbor-ops`, posted, 90);
    await firm.second.send("desk", ASKED);
    await firm.second.nextWith("I've asked tally under its post.", 60);
    await until(`tally's run of "${WHO}"`, async () => firm.model.requests.some(all(tally, said(WHO))), 90);
    expect(beyond(WHO)).toEqual([]);
  });

  test("Finch's reply in a thread Theo started, where tally wrote with buzz before it answered him, is Finch's request: its run has no job, timer or plug tools, and tally's answer reaches Finch", async () => {
    const [THEO, CHECKING, DUE] = [
      "When is the 4B elevator inspection?",
      "Checking the elevator records now.",
      "The 4B elevator inspection is on December 4.",
    ];
    const [ASK, WHO, ANSWER] = [
      "In Theo's elevator thread, ask tally who does the inspection.",
      "@tally who does the 4B elevator inspection?",
      "Harbor Lift does the 4B elevator inspection.",
    ];
    // His message's id is known once Buzz's CLI has sent it, which can be after tally's run asks the model.
    const written = Promise.withResolvers<string>();
    const args = async () => [
      "messages",
      "send",
      "--channel",
      buzz.channel,
      "--reply-to",
      await written.promise,
    ];
    firm.model.on(all(tally, said(THEO)), async () =>
      call(TOOLS.buzz, { args: [...(await args()), "--content", "-"], input: CHECKING }),
    );
    firm.model.on(all(tally, answered(TOOLS.buzz)), say(DUE));
    firm.model.on(all(main(finch), said(ASK)), async () => toTally(WHO, await written.promise));
    firm.model.on(all(finch, answered(TOOLS.buzz)), say("I've asked tally in Theo's thread."));
    firm.model.on(all(tally, said(WHO)), say(ANSWER));
    firm.model.on(all(finch, said(ANSWER)), say(`tally says: ${ANSWER}`));

    const root = (await buzz.write("theo", "harbor-ops", THEO, { to: key })).id;
    written.resolve(root);
    await buzz.inThread(root, DUE, 90, key);
    // Both are in his thread. Buzz times an event to the second, so two written in one second list in either order.
    expect((await buzz.thread(root, key)).map((m) => m.content).sort()).toEqual([CHECKING, DUE].sort());
    await firm.second.send("desk", ASK);
    await firm.second.nextWith(`tally says: ${ANSWER}`, 120);
    expect(beyond(WHO)).toEqual([]);
  });

  test("Rosa tells tally only Ana may ask it now: Theo's next mention gets no answer and no eyes, and Ana's still does", async () => {
    const LIMIT = "From now on only Ana may ask you for work.";
    const LIMITED = "Done: only Ana may ask me now.";
    const THEO = "Can you pull the 4B ledger for me?";
    const ANA = "Can you pull the 4B ledger for October?";
    const LEDGER = "Here is the October 4B ledger total: $2,310.";
    firm.model.on(all(main(tally), said(LIMIT)), call("settings", { answers: ["Ana"] }));
    firm.model.on(all(tally, answered("settings")), say(LIMITED));
    firm.model.on(all(tally, said(ANA)), say(LEDGER));

    await buzz.write("rosa", "dm", LIMIT, { to: key });
    await buzz.inDm("rosa", key, LIMITED, 60);
    const { id: theo } = await buzz.write("theo", "harbor-ops", THEO, { to: key });
    const { id: ana } = await buzz.write("ana", "harbor-ops", ANA, { to: key });
    await buzz.inThread(ana, LEDGER, 90, key);
    expect(await buzz.thread(theo, key)).toEqual([]);
    expect(await buzz.reactionsOf(theo, key)).toEqual([]);
    expect(firm.model.requests.filter(said(THEO))).toEqual([]);
  });

  test("Rosa lets Theo ask tally again, then anyone in Buzz: each waits for her yes, the question names Theo by his name and the start of his Buzz key, she hears tally's confirmation once while its Buzz door starts again, and Theo's next mention is answered", async () => {
    const OUTCOME = '"answer":"yes"';
    const LIMITED = "Done: only Ana may ask me now.";
    const [ADD, ADD_ASKED, ADD_YES, ADDED] = [
      "Theo may ask you for work too.",
      "duck asks your yes before Theo may ask me.",
      "Yes, add Theo.",
      "Done: Ana and Theo may ask me now.",
    ];
    const [OPEN, OPEN_ASKED, OPEN_YES, OPENED] = [
      "Anyone in Buzz may ask you for work again.",
      "duck asks your yes before anyone may ask me.",
      "Yes, let anyone ask.",
      "Done: anyone in Buzz may ask me again.",
    ];
    const THEO = "Can you pull the 4B ledger for November?";
    const LEDGER = "The November 4B ledger total is $2,480.";
    const EVERY = { times: Number.POSITIVE_INFINITY };
    firm.model.on(all(main(tally), said(ADD)), call("settings", { answers: ["Ana", "Theo"] }));
    firm.model.on(all(main(tally), said(OPEN)), call("settings", { answers: ["anyone"] }));
    firm.model.on(all(tally, answered("settings")), say(ADD_ASKED));
    firm.model.on(all(tally, answered("settings")), say(OPEN_ASKED));
    firm.model.on(all(reading, said(ADD_YES)), say("yes"));
    firm.model.on(all(reading, said(OPEN_YES)), say("yes"));
    // Her yes and what came of it reach her conversation in one run or in two.
    firm.model.on(all(main(tally), said(OUTCOME)), say(ADDED));
    firm.model.on(all(main(tally), said(OUTCOME)), say(OPENED));
    firm.model.on(all(main(tally), said(ADD_YES)), say("Noted."), EVERY);
    firm.model.on(all(main(tally), said(OPEN_YES)), say("Noted."), EVERY);
    firm.model.on(all(tally, said(THEO)), say(LEDGER));

    await buzz.write("rosa", "dm", ADD, { to: key });
    const question = await buzz.inDm("rosa", key, "Your yes is needed for duck's settings", 60);
    // Each named person as duck's asks name someone: no JSON and no whole key.
    expect(question.content).toContain(`"Ana" (Buzz key ${buzz.keys.ana.slice(0, 8)})`);
    expect(question.content).toContain(`"Theo" (Buzz key ${buzz.keys.theo.slice(0, 8)})`);
    expect(question.content).not.toContain(buzz.keys.theo);
    expect(question.content).not.toContain("{");
    await buzz.inDm("rosa", key, ADD_ASKED, 60);
    const { id: yes } = await buzz.write("rosa", "dm", ADD_YES, { to: key });
    // What she sees on her yes while the door starts again, as it changes.
    const seen: string[][] = [];
    const look = async () => {
      const now = await buzz.reactionsOf(yes, key);
      if (JSON.stringify(now) !== JSON.stringify(seen.at(-1))) seen.push(now);
      return now;
    };
    await until(
      `"${ADDED}" in her DM`,
      async () => {
        await look();
        return (await buzz.dmOf("rosa", key)).some((m) => m.content === ADDED);
      },
      90,
    );
    await until("no reaction left on her yes", async () => (await look()).length === 0, 60);
    console.log(`the reactions on her yes, as they changed: ${JSON.stringify(seen)}`);
    const { id: theo } = await buzz.write("theo", "harbor-ops", THEO, { to: key });
    await buzz.inThread(theo, LEDGER, 90, key);

    await buzz.write("rosa", "dm", OPEN, { to: key });
    await buzz.inDm("rosa", key, "answers: anyone in Buzz", 60);
    await buzz.inDm("rosa", key, OPEN_ASKED, 60);
    await buzz.write("rosa", "dm", OPEN_YES, { to: key });
    await buzz.inDm("rosa", key, OPENED, 90);
    const dm = (await buzz.dmOf("rosa", key)).map((m) => m.content);
    const once = [LIMITED, ADD_ASKED, ADDED, OPEN_ASKED, OPENED];
    expect(once.map((t) => dm.filter((m) => m === t).length)).toEqual(once.map(() => 1));
  });

  test("what tally writes for Ana's request is kept in its version history as the run ends", async () => {
    const ASK = "Note that the 4B boiler's warranty runs to March 2027.";
    const NOTE = "4B boiler: warranty runs to March 2027 (Ana, in harbor-ops).";
    firm.model.on(
      all(tally, said(ASK)),
      call("write", { path: "/duck/home/notes/4b-boiler.md", content: `${NOTE}\n` }),
    );
    firm.model.on(all(tally, answered("write")), say("Noted."));

    const { id } = await buzz.write("ana", "harbor-ops", ASK, { to: key });
    await buzz.inThread(id, "Noted.", 90, key);
    // Kept before the answer is posted.
    const history = `${firm.folder}/storage/${team.coworker}/history`;
    const kept = Bun.spawnSync(["git", `--git-dir=${history}`, "show", "HEAD:notes/4b-boiler.md"]);
    expect(kept.stdout.toString()).toBe(`${NOTE}\n`);
  });
});

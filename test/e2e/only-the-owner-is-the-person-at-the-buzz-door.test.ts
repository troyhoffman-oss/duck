import { expect, test } from "bun:test";
import {
  all,
  answered,
  call,
  E2E,
  held,
  type ModelRequest,
  reading,
  said,
  say,
  shows,
  sorter,
  startBuzz,
  startFirm,
  TOOLS,
  until,
} from "../kit";

const ASK = "Send Dana the 4B renewal terms.";
const MAIL = {
  to: "dana.reyes@harbor.example",
  subject: "4B renewal terms",
  body: "Hi Dana, the renewal for 4B is $1,900 a month from January 1.",
};
const STEER = "Make it 12 months.";
/**
 * What is written while her run goes on: by Theo in a DM and in harbor-ops, by her in harbor-ops without
 * naming the coworker, and by Heron in harbor-ops.
 */
const MIDRUN = {
  dm: "Make it 18 months.",
  channel: "Make it 20 months.",
  unnamed: "Make it 30 months.",
  agent: "Make it 24 months.",
};
/** What others write while her ask waits, each in words the script reads as a yes. */
const YESES = { dm: "Yes, send it.", channel: "Yes, send it now.", agent: "Yes, send it today." };
const YES = "Yes, go ahead and send it.";

/** A run of the main conversation, which has the list and not `tell`; a work-lane run has both. */
const main = (r: ModelRequest) => r.has(TOOLS.writeItem) && !r.has(TOOLS.tell);
const work = (r: ModelRequest) => r.has(TOOLS.tell);
const others = [...Object.values(MIDRUN), ...Object.values(YESES)];

test.failing(
  "at the Buzz door only the owner's own words are the person's: an agent she owns reaches the work lane as outside words; that agent's words and another person's DM and mention neither start nor steer her run nor answer her ask; hers do all three",
  async () => {
    await using buzz = await startBuzz();
    await using firm = await startFirm({ buzz });
    firm.model.on(sorter, say("wake: someone writes to the coworker in Buzz"), {
      times: Number.POSITIVE_INFINITY,
    });
    firm.model.on(work, say("Nothing for Rosa in that."), { times: Number.POSITIVE_INFINITY });
    firm.model.on(all(main, said(ASK)), held("asking", say("I'll send Dana the 4B terms.")));
    firm.model.on(all(main, shows(STEER)), call("send_mail", MAIL));
    firm.model.on(answered("send_mail"), say("I've asked you before it goes."));
    // Any yes duck reads is read as a yes, so a yes it read as hers would send.
    firm.model.on((r) => reading(r) && [YES, ...Object.values(YESES)].some((y) => said(y)(r)), say("yes"), {
      times: Number.POSITIVE_INFINITY,
    });
    firm.model.on(main, say("Done."), { times: Number.POSITIVE_INFINITY });
    const db = firm.db();
    const hers = () =>
      db
        .query<{ state: string }, []>("select state from inbox where source = 'buzz' order by id")
        .all()
        .map((e) => e.state);
    const outsideWords = (text: string) => () =>
      firm.model.requests.some((r) => work(r) && r.shows(text) && r.shows("Heron") && r.shows("harbor-ops"));

    await buzz.person.online();
    await buzz.person.send(ASK);
    await firm.model.reached("asking");
    await buzz.write("theo", "dm", MIDRUN.dm);
    await buzz.write("theo", "harbor-ops", MIDRUN.channel);
    await buzz.write("rosa", "harbor-ops", MIDRUN.unnamed, { mention: false });
    await buzz.write("heron", "harbor-ops", MIDRUN.agent);
    // buzz-acp takes events in order, so once Heron's is in, those before it have been taken or dropped.
    await until(
      "Heron's words on the work lane, with who and where",
      outsideWords(MIDRUN.agent),
      60,
      firm.trouble,
    );
    expect(hers()).toEqual(["running"]);

    await buzz.write("rosa", "harbor-ops", STEER);
    await until("her mention handed to her run", () => hers().join() === "running,running", 30, firm.trouble);
    firm.model.release("asking");
    const sent = () => db.query("select 1 from outbox where kind = 'ask' and state = 'sent'").get() !== null;
    await until("her question sent", sent, 60, firm.trouble);

    await buzz.write("theo", "dm", YESES.dm);
    await buzz.write("theo", "harbor-ops", YESES.channel);
    await buzz.write("heron", "harbor-ops", YESES.agent);
    await until("Heron's yes on the work lane", outsideWords(YESES.agent), 60, firm.trouble);
    await Bun.sleep(5000);
    expect(firm.mail.callsTo("send_mail")).toHaveLength(0);

    await buzz.person.send(YES);
    await until("the held call", () => firm.mail.callsTo("send_mail").length > 0, 60, firm.trouble);
    await Bun.sleep(3000);
    expect(firm.mail.callsTo("send_mail").map((c) => c.input)).toEqual([MAIL]);
    expect(firm.model.requests.filter(main).filter((r) => others.some((t) => r.shows(t)))).toEqual([]);
    expect(firm.model.requests.filter((r) => r.shows(MIDRUN.unnamed))).toEqual([]);
    expect(hers()).toEqual(["done", "done", "done"]);
    expect(firm.model.requests.filter(reading).map((r) => r.last)).toEqual([expect.stringContaining(YES)]);

    db.close();
  },
  E2E,
);

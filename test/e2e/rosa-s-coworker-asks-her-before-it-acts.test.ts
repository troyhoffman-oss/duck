import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  all,
  answered,
  call,
  clock,
  coworkerRun,
  decides,
  E2E,
  type Firm,
  failure,
  harbor,
  held,
  idIn,
  type ModelRequest,
  reading,
  said,
  say,
  shows,
  sorter,
  startFirm,
  TOOLS,
  until,
} from "../kit";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const DANA = "dana.reyes@harbor.example";
const MAIL = {
  to: DANA,
  subject: "4B renewal terms",
  body: "Hi Dana, the renewal for 4B is $1,900 a month from January 1.",
};
const YES = "Yes, send it.";
const NO = "No, hold it for now.";
/** What a held call's session is told on a yes. */
const OUTCOME = '"answer":"yes"';

/**
 * Dana's mail `ref` starts a work-lane session, which writes the terms to a file, calls send_file, which the
 * kit's setup makes ask first, and changes the file; Rosa is asked with the file as it was when held, and
 * nothing reaches the plug. duck reads her `YES` as a yes. Returns the call as the plug must get it, and the
 * mail's text.
 */
async function heldFile(firm: Firm, ref: string) {
  const [TERMS, ASKED, CHANGED] = ["/duck/home/4B-terms.txt", `4B: $1,900 a month (${ref})`, "4B: $2,100"];
  const text = `Hi Rosa, could you send me the 4B renewal terms as a file? (${ref})`;
  firm.model.on(all(sorter, shows(text)), say("wake: a tenant asks for her renewal terms"));
  firm.model.on(all(coworkerRun, said(text)), call("shell", { command: `printf '${ASKED}' > ${TERMS}` }));
  firm.model.on(answered("shell"), call("send_file", { to: DANA, file: TERMS }));
  firm.model.on(
    answered("send_file"),
    call("shell", { command: `printf '${CHANGED}' > ${TERMS} && cat ${TERMS}` }),
  );
  firm.model.on(answered("shell"), say("Held for Rosa's yes."));
  firm.model.on(all(reading, said(YES)), say("yes"));

  const payload = { from: `Dana Reyes <${DANA}>`, subject: "4B renewal terms", text };
  expect(await firm.push({ ref, payload })).toEqual({ status: 202, body: { duplicate: false } });
  const question = await firm.person.nextWith("Your yes is needed", 90);
  expect(question.text).toContain(DANA);
  expect(question.text).toContain("file: 4B-terms.txt");
  expect(question.files.map((f) => [f.name, Buffer.from(f.bytes).toString()])).toEqual([
    ["4B-terms.txt", ASKED],
  ]);
  await until("the session's last word", () => firm.model.requests.some(said(CHANGED)), 30, firm.trouble);
  expect(firm.mail.callsTo("send_file")).toEqual([]);
  return { sent: { to: DANA, file: b64(ASKED) }, text };
}

/** Dana's terms under a subject of their own, so each step's question is told apart from those still open. */
const terms = (subject: string) => ({ ...MAIL, subject });
const EVERY = { times: Number.POSITIVE_INFINITY };
/** The conversation a reading of a reply was shown (SPEC part 9), and the question it reads for. */
const stateOf = (r: ModelRequest | undefined) =>
  JSON.parse(String(r?.body.state)) as {
    question: { entry: number; number?: number };
    conversation: { from: string; at: string; text: string }[];
  };
/** A reading of a reply for the question whose message holds `text`, and that is question `number` there. */
const readingOf = (text: string, number?: number) => (r: ModelRequest) => {
  if (!reading(r)) return false;
  const { question, conversation } = stateOf(r);
  return !!conversation[question.entry - 1]?.text.includes(text) && question.number === number;
};
/** Who wrote each entry of the conversation a reading was shown, and its text. */
const shownIn = (r: ModelRequest | undefined) => stateOf(r).conversation.map((e) => [e.from, e.text]);

setDefaultTimeout(E2E);

describe("Rosa's coworker asks her before it acts", () => {
  let firm: Firm;
  beforeAll(async () => {
    firm = await startFirm();
  }, E2E);
  afterAll(() => firm?.[Symbol.asyncDispose](), E2E);
  afterEach(() => firm.step(), E2E);

  test("a file a plug's tool gives is saved to the coworker's files, its shell reads it at the path it is told, and named in a message it reaches Rosa by its name, as the archive keeps it", async () => {
    const ASK = "Pull the 4B lease out of Dana's mail.";
    const [LEASE, SECOND, PICTURE] = ["%PDF-1.7 the 4B lease", "%PDF-1.7 the earlier draft", "a picture"];
    const AT = "/duck/home/plugs/mail";
    const attached = (blob: string) => ({
      type: "resource",
      resource: { uri: "mail://m-1/attachments/4B%20lease.pdf", mimeType: "application/pdf", blob },
    });
    firm.mail.answer("get_attachments", () => ({
      content: [
        { type: "text", text: "The attachments of mail m-1." },
        attached(b64(LEASE)),
        attached(b64(SECOND)),
        { type: "image", data: b64(PICTURE), mimeType: "image/png" },
      ],
    }));
    firm.model.on(said(ASK), call("get_attachments", { mail: "m-1" }));
    firm.model.on(answered("get_attachments"), call("shell", { command: `cat ${AT}/4B-lease.pdf` }));
    firm.model.on(answered("shell"), (r) =>
      say(r.last.includes(LEASE) ? `The 4B lease is at ${AT}/4B-lease.pdf.` : "I could not read it."),
    );

    await firm.person.send("desk", ASK);
    const reply = await firm.person.next(60);
    expect(reply.text).toBe("The 4B lease is at 4B-lease.pdf.");
    expect(reply.files.map((f) => [f.name, Buffer.from(f.bytes).toString()])).toEqual([
      ["4B-lease.pdf", LEASE],
    ]);
    const given = firm.model.requests.find(answered("get_attachments"))?.last;
    expect(given).toContain(`saved at ${AT}/4B-lease.pdf`);
    expect(given).not.toContain(b64(LEASE));
    const [line] = await firm.logged("gate");
    expect(line?.files).toEqual([
      { path: `${AT}/4B-lease.pdf`, bytes: LEASE.length },
      { path: `${AT}/4B-lease-2.pdf`, bytes: SECOND.length },
      { path: `${AT}/get_attachments.png`, bytes: PICTURE.length },
    ]);
    expect(await firm.logs()).not.toContain(b64(LEASE));
    const db = firm.db();
    const kept = db.query("select text, files from messages where way = 'out'").all();
    db.close();
    expect(kept).toEqual([
      { text: "The 4B lease is at 4B-lease.pdf.", files: JSON.stringify([`${AT}/4B-lease.pdf`]) },
    ]);
  });

  test("the coworker hands a plug's tool a file it made by its path and the plug gets its bytes; a file named before it is written is told as missing, and a path outside its files is refused", async () => {
    const ASK = "Store the rent roll in the shared drive.";
    const CSV = "unit,rent\n4B,1900\n";
    const MADE = "/duck/home/rent-roll.csv";
    const [OUTSIDE, LINK] = ["/duck/goose/config/config.yaml", "/duck/home/config-link"];
    const make = `printf 'unit,rent\\n4B,1900\\n' > ${MADE} && ln -s /duck/secrets.env ${LINK}`;
    // Each call is made apart, since a call's id is given once.
    const store = (name: string, file: string) => () => call("store_file", { name, file });
    firm.model.on(said(ASK), store("rent-roll.csv", MADE));
    firm.model.on(answered("store_file"), call("shell", { command: make }));
    firm.model.on(answered("shell"), store("rent-roll.csv", MADE));
    firm.model.on(answered("store_file"), store("config.yaml", OUTSIDE));
    firm.model.on(answered("store_file"), store("config.yaml", LINK));
    firm.model.on(answered("store_file"), say("The rent roll is stored."));

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("stored", 60);

    expect(firm.mail.callsTo("store_file").map((c) => c.input)).toEqual([
      { name: "rent-roll.csv", file: b64(CSV) },
    ]);
    const lines = (await firm.logged("gate")).filter((l) => l.tool === "mail__store_file");
    expect(lines.map((l) => [l.outcome, l.files, l.why])).toEqual([
      ["refused", undefined, expect.stringContaining(`There is no file at ${MADE}`)],
      ["ok", [{ path: MADE, bytes: CSV.length }], undefined],
      ["refused", undefined, expect.stringContaining(`${OUTSIDE} is not one of your files`)],
      ["refused", undefined, expect.stringContaining(`${LINK} is not one of your files`)],
    ]);
    expect(await firm.logs()).not.toContain(b64(CSV));
    const db = firm.db();
    const kept = db
      .query<{ input: string }, []>("select input from tool_calls where tool like '%store_file'")
      .all();
    db.close();
    expect(kept.map((k) => JSON.parse(k.input))).toContainEqual({ name: "rent-roll.csv", file: MADE });
  });

  test("harbor's box on its mail plug fills in an argument, gives the coworker plain text for HTML and refuses a search too big to read; the gate logs that refusal and a plug's failure, each in one line beside the call", async () => {
    const ASK = "What did Dana say about the 4B lease, and can you save her a draft?";
    const TOO_MANY = "find_mail reads at most 25 mails at a time; ask for fewer.";
    const html = "<p>Hi Rosa,</p><p>The <b>4B</b> lease is signed &amp; filed.</p>";
    firm.mail.answer("find_mail", () => [{ from: DANA, subject: "4B lease", body: html }]);
    firm.mail.answer("save_draft", () => {
      throw new Error("the mailbox is offline\nretry later");
    });
    firm.model.on(said(ASK), call("find_mail", { query: "4B lease" }));
    firm.model.on(answered("find_mail"), call("find_mail", { query: "lease", top: 100 }));
    firm.model.on(
      answered("find_mail"),
      call("save_draft", { to: DANA, subject: "4B lease", body: "Signed." }),
    );
    firm.model.on(answered("save_draft"), say("Dana says the 4B lease is signed; the draft did not save."));

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("signed", 60);

    expect(firm.mail.callsTo("find_mail").map((c) => c.input)).toEqual([
      { query: "4B lease", select: ["from", "subject", "received", "body"] },
    ]);
    const shaped = firm.model.requests.find(answered("find_mail"))?.last;
    expect(shaped).toContain("Hi Rosa, The 4B lease is signed & filed.");
    expect(shaped).not.toContain("<p>");
    const calls = await firm.logged("gate");
    expect(calls).toContainEqual({
      gate: harbor.coworker,
      tool: "mail__find_mail",
      state: "free",
      outcome: "refused",
      ms: expect.any(Number),
      why: TOO_MANY,
    });
    expect(calls.find((c) => c.tool === "mail__save_draft")).toMatchObject({
      outcome: "failed",
      why: "the plug answered tools/call with: the mailbox is offline",
    });
  });

  test("a call that does not fit its tool is refused: a plug's tool called in the wrong shape is never reached, free or ask first", async () => {
    const ASK = "Save Dana a draft of the 4B renewal terms, then send them to Lee.";
    firm.model.on(said(ASK), call("save_draft", { to: DANA, subject: MAIL.subject, text: MAIL.body }));
    firm.model.on(
      answered("save_draft"),
      call("send_mail", { ...MAIL, to: ["lee.okafor@tidewater.example"] }),
    );
    firm.model.on(answered("send_mail"), say("Neither went through."));

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("Neither", 60);

    expect(firm.mail.calls).toEqual([]);
    const calls = await firm.logged("gate");
    expect(calls.find((c) => c.tool === "mail__save_draft")).toMatchObject({
      state: "free",
      outcome: "refused",
      why: "mail__save_draft was not called: body is missing.",
    });
    expect(calls.find((c) => c.tool === "mail__send_mail")).toMatchObject({
      state: "ask first",
      outcome: "refused",
      why: "mail__send_mail was not called: to must be string.",
    });
  });

  test("ask first: Rosa is asked with the exact mail, and her no, which duck reads from her own words and what she was sent, runs nothing and comes to the conversation that made the call with her message", async () => {
    const ASK = "Send Dana the 4B renewal terms.";
    firm.model.on(said(ASK), call("send_mail", MAIL));
    firm.model.on(answered("send_mail"), say("I've asked you before it goes."));
    firm.model.on(all(reading, said(NO)), say("no"));
    firm.model.on(all(coworkerRun, said(NO), said('"answer":"no"')), say("It stays unsent."));

    await firm.person.send("desk", ASK);
    // The run's answer reaches her, then the question, which goes once the run ends.
    await firm.person.nextWith("I've asked you", 30);
    const question = await firm.person.nextWith(MAIL.to, 30);
    expect(question.text).toContain(MAIL.subject);
    expect(question.text).toContain(MAIL.body);
    await firm.person.send("desk", NO);
    await firm.person.nextWith("It stays unsent", 30);

    expect(firm.mail.callsTo("send_mail")).toEqual([]);
    const read = firm.model.requests.filter(reading);
    expect(read.map((r) => r.last)).toEqual([expect.stringContaining(`${question.text}\n\n`)]);
    expect(read[0]?.last).toEndWith(NO);
    expect(read[0]?.shows("I've asked you before it goes.")).toBe(true);
    expect(firm.model.requests.find(all(coworkerRun, said(NO)))?.last).toContain("answers ask");
    const db = firm.db();
    const answers = db.query("select answer from outbox where kind = 'ask'").all();
    db.close();
    expect(answers).toEqual([{ answer: "no" }]);
  });

  test("a box raises a free call to ask first: harbor's box holds a draft for someone outside the firm, and Rosa's yes, which duck reads, saves it once, exactly as shown", async () => {
    const ASK = "Draft the 4B renewal for Dana and for Lee.";
    const INSIDE = { to: DANA, subject: "4B renewal", body: "Hi Dana, here is the renewal." };
    const OUTSIDE = {
      to: "lee.okafor@tidewater.example",
      subject: "4B renewal",
      body: "Hi Lee, here it is.",
    };
    const SAVE = "Yes, save Lee's too.";
    firm.model.on(said(ASK), call("save_draft", INSIDE));
    firm.model.on(answered("save_draft"), call("save_draft", OUTSIDE));
    firm.model.on(
      answered("save_draft"),
      say("Dana's draft is saved. Lee is outside the firm, so I've asked you first."),
    );
    firm.model.on(all(reading, said(SAVE)), say("yes"));
    // The held call was made in the main conversation, so its outcome comes to it with her yes or after it.
    firm.model.on(all(coworkerRun, said(OUTCOME)), say("Lee's draft is saved."));
    firm.model.on(all(coworkerRun, said(SAVE)), say("Saving Lee's."), { times: Number.POSITIVE_INFINITY });

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("I've asked you first", 30);
    const question = await firm.person.nextWith(OUTSIDE.to, 30);
    expect(question.text).toContain(OUTSIDE.body);
    expect(firm.mail.callsTo("save_draft").map((c) => c.input)).toEqual([INSIDE]);

    await firm.person.send("desk", SAVE);
    await firm.person.nextWith("Lee's draft is saved", 60);
    expect(firm.mail.callsTo("save_draft").map((c) => c.input)).toEqual([INSIDE, OUTSIDE]);
  });

  test("a call held before a restart runs once on Rosa's yes after it, which duck reads, as it was held, with its file's bytes as they were though the file changed since, and its outcome reaches the session that made it", async () => {
    const { sent, text } = await heldFile(firm, "<terms-4b@harbor.example>");
    firm.model.on(all(coworkerRun, said(OUTCOME)), say("Dana has the terms."));
    firm.model.on(all(coworkerRun, said(YES)), say("Sent."));
    await firm.restart();

    await firm.person.send("desk", YES);
    await firm.person.nextWith("Sent.", 90);
    await until("the outcome", () => firm.model.requests.some(said(OUTCOME)), 90, firm.trouble);
    expect(firm.mail.callsTo("send_file").map((c) => c.input)).toEqual([sent]);
    const outcome = firm.model.requests.find(said(OUTCOME));
    expect(outcome?.last).toContain("sent as s-1");
    // The session Dana's mail started, which made the call, and not the main conversation the yes was given in.
    expect(outcome?.shows(text)).toBe(true);
    expect(outcome?.shows(YES)).toBe(false);
    const ok = (await firm.logged("gate")).find((c) => c.tool === "mail__send_file" && c.outcome === "ok");
    expect(ok?.files).toEqual([
      {
        path: expect.stringMatching(/^\/duck\/files\/held\/.+\/4B-terms\.txt$/),
        bytes: expect.any(Number),
      },
    ]);
  });

  test("a restart while the yes's call is at the plug runs it no second time, and the session that made it is told that what came of it is unknown", async () => {
    const CUT = "duck stopped while the call ran";
    const { sent, text } = await heldFile(firm, "<terms-4b-again@harbor.example>");
    firm.model.on(all(coworkerRun, said(YES)), say("Sending Dana the terms."));
    firm.model.on(all(coworkerRun, said(CUT)), say("I'll check with Dana before I send them again."));
    firm.mail.hold("send_file");

    await firm.person.send("desk", YES);
    await firm.mail.reached("send_file");
    await firm.person.nextWith("Sending Dana the terms.", 60);
    await firm.stop();
    firm.mail.release("send_file");
    await firm.start();

    const told = () => firm.model.requests.find(all(coworkerRun, said(CUT)));
    await until("the call's session told", () => told() !== undefined, 90, firm.trouble);
    expect(firm.mail.callsTo("send_file").map((c) => c.input)).toEqual([sent]);
    // The session Dana's mail started, which made the call.
    expect(told()?.shows(text)).toBe(true);
  });

  test("a question nobody answers is a no when Rosa's quiet hours begin, though she wrote meanwhile in words that answer it neither, which reach the coworker as an ordinary message; the coworker is told, and a later yes runs nothing", async () => {
    const ASK = "Send Dana the 4B renewal terms, please.";
    const ASIDE = "Is that the January rate?";
    let ask = 0;
    firm.model.on(said(ASK), call("send_mail", MAIL));
    firm.model.on(answered("send_mail"), (r) => {
      ask = idIn(r.last);
      return say("I've asked you before it goes.");
    });
    firm.model.on(
      all(coworkerRun, (r) => r.last.includes(`"ask":${ask},"answer":"no"`)),
      say("Your quiet hours began, so the mail stays unsent."),
    );
    firm.model.on(all(reading, said(ASIDE)), say("neither"));
    firm.model.on(all(coworkerRun, said(ASIDE)), say("Yes, it starts January 1."));
    firm.model.on(all(coworkerRun, said(YES)), say("That ask has lapsed."));

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("I've asked you", 30);
    await firm.person.nextWith(MAIL.to, 30);
    await firm.person.send("desk", ASIDE);
    expect((await firm.person.next(30)).text).toBe("Yes, it starts January 1.");
    expect(firm.model.requests.find(all(coworkerRun, said(ASIDE)))?.last).not.toContain("answers ask");

    // Quiet hours from the next minute in Rosa's zone, for an hour.
    await firm.reinstall((setup) => {
      setup.settings.quiet = [1 / 60, 1 + 1 / 60].map((h) => clock(setup.zone, h));
    });
    await firm.person.nextWith("quiet hours began", 150);

    await firm.person.send("desk", YES);
    await firm.person.nextWith("lapsed", 30);
    expect(firm.mail.callsTo("send_mail")).toEqual([]);
    // Her yes came after the question was a no, and after other messages: duck read only her aside.
    expect(firm.model.requests.filter(reading).map((r) => r.last)).toEqual([expect.stringContaining(ASIDE)]);
  });

  test("in quiet hours a message waits unless it is urgent", async () => {
    const mail = (ref: string, subject: string, text: string) => ({
      ref,
      payload: { from: "someone@elsewhere.example", subject, text },
    });
    firm.model.on(all(sorter, shows("Hallway paint")), say("wake: a vendor quote"));
    firm.model.on(
      all(coworkerRun, shows("Hallway paint")),
      call(TOOLS.tell, { text: "The hallway paint quote came in at $2,400." }),
    );
    firm.model.on(answered(TOOLS.tell), say("Told."));
    firm.model.on(all(sorter, shows("Water leak")), say("urgent: a leak in a unit"));
    firm.model.on(
      all(coworkerRun, shows("Water leak")),
      call(TOOLS.tell, { text: "Water is leaking into 3C from 4C.", urgent: true }),
    );
    firm.model.on(answered(TOOLS.tell), say("Told."));
    firm.model.on(
      all(coworkerRun, shows("leaking into 3C")),
      say("Urgent: water is leaking into 3C from 4C."),
    );

    await firm.push(mail("<paint@vendor.example>", "Hallway paint", "Quote attached: $2,400."));
    await until("the tell", () => firm.model.requests.some(answered(TOOLS.tell)), 60, firm.trouble);
    await firm.person.quiet(10);

    await firm.push(
      mail("<leak-3c@harbor.example>", "Water leak in 3C", "Water is coming through the ceiling of 3C."),
    );
    expect((await firm.person.next(60)).text).toContain("leaking into 3C");
  });

  test("harbor's box holds a PDF its mail never handed the coworker for Rosa's yes and tells her and the coworker why; a PDF it handed goes through with no ask, after a restart too, asked for in her next message, which duck reads against the question and which answers it neither", async () => {
    const ASK = "Store Dana's signed 4B lease and a summary of it in the shared drive.";
    const AGAIN = "Store the signed lease once more, please.";
    const [LEASE, SUMMARY] = ["%PDF-1.7 the signed 4B lease", "%PDF-1.7 a summary of the 4B lease"];
    const [HANDED, MADE] = ["/duck/home/plugs/mail/signed-lease.pdf", "/duck/home/4B-summary.pdf"];
    const WHY = "This PDF is not one harbor's mail handed the coworker: it was made or changed since.";
    firm.mail.answer("get_attachments", () => ({
      content: [
        {
          type: "resource",
          resource: {
            uri: "mail://m-2/attachments/signed%20lease.pdf",
            mimeType: "application/pdf",
            blob: b64(LEASE),
          },
        },
      ],
    }));
    const store = (name: string, file: string) => () => call("store_file", { name, file });
    firm.model.on(said(ASK), call("get_attachments", { mail: "m-2" }));
    firm.model.on(answered("get_attachments"), store("4B lease.pdf", HANDED));
    firm.model.on(answered("store_file"), call("shell", { command: `printf '%s' '${SUMMARY}' > ${MADE}` }));
    firm.model.on(answered("shell"), store("4B summary.pdf", MADE));
    firm.model.on(answered("store_file"), say("The lease is stored; the summary waits for your yes."));

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("waits for your yes", 60);
    const question = await firm.person.nextWith("Your yes is needed", 30);
    expect(question.text).toBe(
      `Your yes is needed for mail's store_file, exactly this:\n${WHY}\nname: 4B summary.pdf\nfile: 4B-summary.pdf`,
    );
    expect(firm.model.requests.filter(answered("store_file")).at(-1)?.last).toContain(`. ${WHY} duck asks `);
    expect(firm.mail.callsTo("store_file").map((c) => c.input)).toEqual([
      { name: "4B lease.pdf", file: b64(LEASE) },
    ]);

    await firm.restart();
    firm.model.on(all(reading, said(AGAIN)), say("neither"));
    firm.model.on(said(AGAIN), store("4B lease.pdf", HANDED));
    firm.model.on(answered("store_file"), say("Stored again."));
    await firm.person.send("desk", AGAIN);
    await firm.person.nextWith("Stored again.", 90);
    expect(firm.mail.callsTo("store_file").map((c) => c.input)).toEqual([
      { name: "4B lease.pdf", file: b64(LEASE) },
      { name: "4B lease.pdf", file: b64(LEASE) },
    ]);
    expect(firm.model.requests.filter(reading)).toHaveLength(1);
  });

  test("two calls held in one run are asked in one message, each numbered, and one reply answers both: her yes to the first runs it once and her no to the second drops it", async () => {
    const ASK = "Send Dana the 4B terms and Lee the 5C terms.";
    const LEE = {
      to: "lee.okafor@tidewater.example",
      subject: "5C renewal terms",
      body: "Hi Lee, 5C renews at $2,050.",
    };
    const BOTH = "Yes to the first, but hold the second.";
    firm.model.on(all(coworkerRun, said(ASK)), call("send_mail", MAIL));
    firm.model.on(answered("send_mail"), call("send_mail", LEE));
    firm.model.on(answered("send_mail"), say("I've asked you about both."));
    firm.model.on(readingOf(MAIL.subject, 1), say("yes"));
    firm.model.on(readingOf(LEE.subject, 2), say("no"));
    firm.model.on(reading, say("neither"), EVERY);
    // Dana's mail was held in the main conversation, so its outcome comes to it with her reply or after it.
    firm.model.on(all(coworkerRun, said(OUTCOME)), say("Dana has the 4B terms; Lee's stay unsent."));
    firm.model.on(all(coworkerRun, said(BOTH)), say("Sending Dana's."), EVERY);

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("about both", 30);
    const question = await firm.person.nextWith("Your yes is needed", 30);
    expect(question.text).toStartWith("1. Your yes is needed for mail's send_mail");
    expect(question.text).toContain("\n\n2. Your yes is needed for mail's send_mail");
    expect(question.text).toContain(LEE.to);
    await firm.person.send("desk", BOTH);
    await firm.person.nextWith("Dana has the 4B terms", 60);

    expect(firm.mail.callsTo("send_mail").map((c) => c.input)).toEqual([MAIL]);
    const readings = firm.model.requests.filter(all(reading, said(BOTH)));
    expect(readings.length > 0 && readings.every((r) => r.last.includes(question.text))).toBe(true);
    const db = firm.db();
    const answers = db.query("select answer from outbox where kind = 'ask' order by id desc limit 2").all();
    db.close();
    expect(answers).toEqual([{ answer: "no" }, { answer: "yes" }]);
  });

  test("when duck cannot read her reply, the question stays open, her words reach the coworker as an ordinary message, and she is told; her next reply answers it", async () => {
    const ASK = "Send Dana the 4B terms once more.";
    const ONCE_MORE = terms("4B renewal terms, once more");
    const [REPLY, AGAIN] = ["Yes, go ahead.", "Yes, send it now."];
    firm.model.on(all(coworkerRun, said(ASK)), call("send_mail", ONCE_MORE));
    firm.model.on(answered("send_mail"), say("I've asked you before it goes."));
    firm.model.on(
      all(readingOf(ONCE_MORE.subject), said(REPLY)),
      failure(529, "overloaded_error", "the decision model is busy"),
    );
    firm.model.on(all(readingOf(ONCE_MORE.subject), said(AGAIN)), say("yes"));
    firm.model.on(reading, say("neither"), EVERY);
    firm.model.on(
      all(coworkerRun, said(REPLY)),
      say("I could not take that as your answer; the question is still open."),
    );
    firm.model.on(all(coworkerRun, said(OUTCOME)), say("Dana has the terms once more."));
    firm.model.on(all(coworkerRun, said(AGAIN)), say("Sending it."), EVERY);

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("I've asked you", 30);
    await firm.person.nextWith(ONCE_MORE.subject, 30);
    await firm.person.send("desk", REPLY);
    await firm.person.nextWith("still open", 90);

    expect(firm.mail.callsTo("send_mail")).toEqual([]);
    const run = firm.model.requests.find(all(coworkerRun, said(REPLY)));
    expect(run?.last).toContain("which stays open");
    expect(run?.last).not.toContain("'s message below answers ask");
    const db = firm.db();
    const open = db.query("select answer from outbox where kind = 'ask' order by id desc limit 1").all();
    db.close();
    expect(open).toEqual([{ answer: null }]);

    await firm.person.send("desk", AGAIN);
    await firm.person.nextWith("once more", 60);
    expect(firm.mail.callsTo("send_mail").map((c) => c.input)).toEqual([ONCE_MORE]);
  });

  test("a question is answered after a clarifying exchange: the decision model is shown the question, her question and the coworker's answer, and her reply, each marked with who wrote it, and her yes runs the call once", async () => {
    const ASK = "Send Dana the 4B terms with the amount.";
    const AMOUNT = terms("4B renewal amount");
    const [WHAT, IS, OK] = ["What's the amount?", "It is $1,900 a month from January 1.", "ok yes"];
    firm.model.on(all(coworkerRun, said(ASK)), call("send_mail", AMOUNT));
    firm.model.on(answered("send_mail"), say("I've asked you before it goes."));
    firm.model.on(all(readingOf(AMOUNT.subject), said(OK)), say("yes"));
    firm.model.on(reading, say("neither"), EVERY);
    firm.model.on(all(coworkerRun, said(WHAT)), say(IS));
    firm.model.on(all(coworkerRun, said(OUTCOME)), say("Dana has the amount."));
    firm.model.on(all(coworkerRun, said(OK)), say("Sending it."), EVERY);

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("I've asked you", 30);
    const question = await firm.person.nextWith(AMOUNT.subject, 30);
    await firm.person.send("desk", WHAT);
    await firm.person.nextWith(IS, 60);
    await firm.person.send("desk", OK);
    await firm.person.nextWith("Dana has the amount", 60);

    expect(firm.mail.callsTo("send_mail").map((c) => c.input)).toEqual([AMOUNT]);
    expect(shownIn(firm.model.requests.find(all(readingOf(AMOUNT.subject), said(OK)))).slice(-4)).toEqual([
      ["duck's question", question.text],
      ["the person", WHAT],
      ["the coworker", IS],
      ["the person", OK],
    ]);
  });

  test("a reply she wrote before its question reached her answers nothing: no model reads it for that question, and the call stays held", async () => {
    const ASK = "Send Dana the 4B terms early.";
    const EARLY = terms("4B renewal terms, early");
    const SOON = "Sounds good, yes.";
    firm.model.on(all(coworkerRun, said(ASK)), call("send_mail", EARLY));
    firm.model.on(answered("send_mail"), held("asking", say("I've asked you before it goes.")));
    firm.model.on(reading, say("neither"), EVERY);
    firm.model.on(all(coworkerRun, said(SOON)), say("Glad to hear it."), EVERY);

    await firm.person.send("desk", ASK);
    await firm.model.reached("asking");
    await firm.person.send("desk", SOON);
    firm.model.release("asking");
    await firm.person.nextWith(EARLY.subject, 60);
    await until(
      "her reply's run",
      () => firm.model.requests.some(all(coworkerRun, said(SOON))),
      60,
      firm.trouble,
    );

    expect(firm.model.requests.filter(readingOf(EARLY.subject))).toEqual([]);
    expect(firm.mail.callsTo("send_mail")).toEqual([]);
    const db = firm.db();
    const open = db.query("select answer from outbox where kind = 'ask' order by id desc limit 1").all();
    db.close();
    expect(open).toEqual([{ answer: null }]);
  });

  test("her message is kept before duck reads it: while the read is held it is in the inbox and no run has it, her next message waits behind it, a stop there loses neither, and at start the first is read again and both reach the coworker in the order she wrote them", async () => {
    const ASK = "Send Dana the 4B terms this afternoon.";
    const LATER = terms("4B renewal terms, this afternoon");
    const [FIRST, SECOND] = ["Hold on, I am checking with Lee.", "Lee is fine with it."];
    firm.model.on(all(coworkerRun, said(ASK)), call("send_mail", LATER));
    firm.model.on(answered("send_mail"), say("I've asked you before it goes."));
    firm.model.on(all(readingOf(LATER.subject), said(FIRST)), held("reading", say("neither")));
    firm.model.on(reading, say("neither"), EVERY);
    firm.model.on(all(coworkerRun, said(FIRST)), say("Noted; it waits for your yes."), EVERY);
    firm.model.on(all(coworkerRun, said(SECOND)), say("Noted that too."), EVERY);
    const states = () => {
      using db = firm.db();
      return db
        .query<{ state: string }, [string, string]>(
          "select inbox.state from inbox join messages on event = inbox.id where way = 'in' and text in (?, ?) order by inbox.id",
        )
        .all(FIRST, SECOND)
        .map((e) => e.state);
    };

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("I've asked you", 30);
    await firm.person.nextWith(LATER.subject, 30);
    await firm.person.send("desk", FIRST);
    await firm.model.reached("reading");
    await firm.person.send("desk", SECOND);
    await until("her second message read", () => states()[1] === "pending", 30, firm.trouble);
    expect(states()).toEqual(["reading", "pending"]);
    expect(firm.model.requests.some(all(coworkerRun, (r) => r.shows(FIRST) || r.shows(SECOND)))).toBe(false);
    await firm.stop();
    firm.model.release("reading");
    await firm.start();

    await firm.person.nextWith("Noted", 90);
    const first = firm.model.requests.find(all(coworkerRun, (r) => said(FIRST)(r) || said(SECOND)(r)))?.last;
    expect(first).toContain(FIRST);
    expect(first?.includes(SECOND) ? first.indexOf(FIRST) < first.indexOf(SECOND) : true).toBe(true);
    await until("both handed on", () => states().every((s) => s === "done"), 60, firm.trouble);
    expect(firm.mail.callsTo("send_mail")).toEqual([]);
  });

  test("an answer the decision model gives that is none of its choices, such as constructor, fails the read: her message still reaches the coworker, and the question stays open", async () => {
    const ASK = "Send Dana the 4B terms by noon.";
    const NOON = terms("4B renewal terms by noon");
    const REPLY = "Go for it.";
    firm.model.on(all(coworkerRun, said(ASK)), call("send_mail", NOON));
    firm.model.on(answered("send_mail"), say("I've asked you before it goes."));
    firm.model.on(
      all(readingOf(NOON.subject), said(REPLY)),
      decides({ reply: { type: "choice", choice: "constructor" } }),
    );
    firm.model.on(reading, say("neither"), EVERY);
    firm.model.on(
      all(coworkerRun, said(REPLY)),
      say("I could not take that as your answer; the question is still open."),
    );

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("I've asked you", 30);
    await firm.person.nextWith(NOON.subject, 30);
    await firm.person.send("desk", REPLY);
    await firm.person.nextWith("still open", 60);

    expect(firm.mail.callsTo("send_mail")).toEqual([]);
    expect(firm.model.requests.find(all(coworkerRun, said(REPLY)))?.last).toContain("which stays open");
    const db = firm.db();
    const open = db.query("select answer from outbox where kind = 'ask' order by id desc limit 1").all();
    db.close();
    expect(open).toEqual([{ answer: null }]);
  });

  test("the model is shown what Rosa was sent just before the question: the coworker's own question there comes first, marked as its, so her yes that could answer either is read as neither and the call stays held", async () => {
    const ASK = "Send Dana the 4B terms, and copy whoever should see them.";
    const COPY = terms("4B renewal terms, with a copy");
    const [WANT, REPLY] = ["Want me to copy Lee as well?", "yes please"];
    firm.model.on(all(coworkerRun, said(ASK)), call("send_mail", COPY));
    firm.model.on(answered("send_mail"), say(`I've asked you before it goes. ${WANT}`));
    firm.model.on(all(readingOf(COPY.subject), said(REPLY)), say("neither"));
    firm.model.on(reading, say("neither"), EVERY);
    firm.model.on(all(coworkerRun, said(REPLY)), say("I'll copy Lee; the mail still waits for your yes."));

    await firm.person.send("phone", ASK);
    const before = await firm.person.nextWith(WANT, 30);
    const question = await firm.person.nextWith(COPY.subject, 30);
    await firm.person.send("phone", REPLY);
    await firm.person.nextWith("still waits", 60);

    expect(shownIn(firm.model.requests.find(readingOf(COPY.subject)))).toEqual([
      ["the coworker", before.text],
      ["duck's question", question.text],
      ["the person", REPLY],
    ]);
    expect(firm.mail.callsTo("send_mail")).toEqual([]);
    const db = firm.db();
    const open = db.query("select answer from outbox where kind = 'ask' order by id desc limit 1").all();
    db.close();
    expect(open).toEqual([{ answer: null }]);
  });

  test("a reply is read as written at the earlier of the time its door gives and when it came: one dated before its question reached her is read for no question there, and one dated ahead is read as written when it came, and her yes runs the call once", async () => {
    const ASK = "Send Dana the 4B terms today.";
    const TODAY = terms("4B renewal terms, today");
    const [BEFORE, AHEAD] = ["Yes, that one is fine.", "Yes, send it today."];
    firm.model.on(all(coworkerRun, said(ASK)), call("send_mail", TODAY));
    firm.model.on(answered("send_mail"), say("I've asked you before it goes."));
    firm.model.on(all(readingOf(TODAY.subject), said(AHEAD)), say("yes"));
    firm.model.on(reading, say("neither"), EVERY);
    firm.model.on(all(coworkerRun, said(BEFORE)), say("Noted."), EVERY);
    firm.model.on(all(coworkerRun, said(OUTCOME)), say("Dana has today's terms."));
    firm.model.on(all(coworkerRun, said(AHEAD)), say("Sending it."), EVERY);
    const sentAt = () => {
      using db = firm.db();
      return db
        .query<{ at: string | null }, []>(
          "select sent_at as at from outbox where kind = 'ask' order by id desc limit 1",
        )
        .get()?.at;
    };

    await firm.person.send("phone", ASK);
    await firm.person.nextWith("I've asked you", 30);
    await firm.person.nextWith(TODAY.subject, 30);
    await until("the question's delivery kept", () => !!sentAt(), 30, firm.trouble);
    await firm.person.send("phone", BEFORE, [], new Date(Date.parse(String(sentAt())) - 5000).toISOString());
    await until(
      "her earlier-dated reply's run",
      () => firm.model.requests.some(all(coworkerRun, said(BEFORE))),
      60,
      firm.trouble,
    );
    expect(firm.model.requests.filter(readingOf(TODAY.subject))).toEqual([]);

    await firm.person.send("phone", AHEAD, [], new Date(Date.now() + 3_600_000).toISOString());
    await firm.person.nextWith("today's terms", 60);
    expect(firm.mail.callsTo("send_mail").map((c) => c.input)).toEqual([TODAY]);
    const read = stateOf(firm.model.requests.find(readingOf(TODAY.subject)));
    expect(Date.parse(String(read.conversation.at(-1)?.at))).toBeLessThanOrEqual(Date.now());
  });

  test("when what her reply answered cannot be kept, it is logged, her message still reaches the coworker answering nothing, and the question stays open", async () => {
    const ASK = "Send Dana the 4B terms tonight.";
    const TONIGHT = terms("4B renewal terms, tonight");
    const REPLY = "Yes, tonight is good.";
    firm.model.on(all(coworkerRun, said(ASK)), call("send_mail", TONIGHT));
    firm.model.on(answered("send_mail"), say("I've asked you before it goes."));
    firm.model.on(all(readingOf(TONIGHT.subject), said(REPLY)), say("yes"));
    firm.model.on(reading, say("neither"), EVERY);
    firm.model.on(all(coworkerRun, said(REPLY)), say("It waits for your yes."));
    const writable = (sql: string) => {
      using db = new Database(join(firm.folder, "storage", harbor.coworker, "duck.db"));
      db.run("pragma busy_timeout = 10000");
      db.run(sql);
    };

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("I've asked you", 30);
    await firm.person.nextWith(TONIGHT.subject, 30);
    // An answer the database refuses to keep, as a full disk would.
    writable(
      "create trigger kit_unkept before update of answer on outbox begin select raise(abort, 'the kit keeps no answer'); end",
    );
    await firm.person.send("desk", REPLY);
    await firm.person.nextWith("waits for your yes", 60);
    writable("drop trigger kit_unkept");

    expect(firm.mail.callsTo("send_mail")).toEqual([]);
    expect(await firm.logs()).toContain("answered was not kept: the kit keeps no answer");
    const db = firm.db();
    const open = db.query("select answer from outbox where kind = 'ask' order by id desc limit 1").all();
    db.close();
    expect(open).toEqual([{ answer: null }]);
  });
});

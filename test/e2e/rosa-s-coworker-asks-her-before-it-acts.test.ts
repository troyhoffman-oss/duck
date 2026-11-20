import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  all,
  answered,
  call,
  clock,
  coworkerRun,
  E2E,
  type Firm,
  harbor,
  idIn,
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
 * nothing reaches the plug. The coworker gives the gate a yes each time it reads Rosa's, `yeses` times.
 * Returns the call as the plug must get it, and the mail's text.
 */
async function heldFile(firm: Firm, ref: string, yeses: number) {
  const [TERMS, ASKED, CHANGED] = ["/duck/home/4B-terms.txt", `4B: $1,900 a month (${ref})`, "4B: $2,100"];
  const text = `Hi Rosa, could you send me the 4B renewal terms as a file? (${ref})`;
  firm.model.on(all(sorter, shows(text)), say("wake: a tenant asks for her renewal terms"));
  firm.model.on(all(coworkerRun, said(text)), call("shell", { command: `printf '${ASKED}' > ${TERMS}` }));
  firm.model.on(answered("shell"), call("send_file", { to: DANA, file: TERMS }));
  let ask = 0;
  firm.model.on(answered("send_file"), (r) => {
    ask = idIn(r.last);
    return call("shell", { command: `printf '${CHANGED}' > ${TERMS} && cat ${TERMS}` });
  });
  firm.model.on(answered("shell"), say("Held for Rosa's yes."));
  firm.model.on(said(YES), () => call(TOOLS.answer, { ask, yes: true }), { times: yeses });

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

  test("ask first: Rosa is asked with the exact mail; an answer no person wrote and an answer not in the tool's shape run nothing, and her no is taken and runs nothing", async () => {
    const ASK = "Send Dana the 4B renewal terms.";
    const SHAPE = "answer was not called: yes is missing.";
    const NEWS = "Dana's 4B lease came back signed.";
    let ask = 0;
    firm.model.on(said(ASK), call("send_mail", MAIL));
    firm.model.on(answered("send_mail"), (r) => {
      ask = idIn(r.last);
      return say("I've asked you before it goes.");
    });
    // A mail wakes the work lane, which tells Rosa; the run that tells her, which her message did not start,
    // answers the ask itself. The tell is urgent, so it leaves her limit on messages as it was.
    firm.model.on(all(sorter, shows("Signed lease 4B")), say("wake: a signed lease"));
    firm.model.on(answered(TOOLS.tell), say("Told."));
    firm.model.on(all(coworkerRun, shows("Signed lease 4B")), call(TOOLS.tell, { text: NEWS, urgent: true }));
    firm.model.on(all(coworkerRun, said(NEWS)), () => call(TOOLS.answer, { ask, yes: true }));
    firm.model.on(answered(TOOLS.answer), say(NEWS));
    firm.model.on(said(NO), () => call(TOOLS.answer, { ask, answer: "no" }));
    firm.model.on(said(SHAPE), () => call(TOOLS.answer, { ask, yes: false }));
    firm.model.on(answered(TOOLS.answer), say("It stays unsent."));

    await firm.person.send("desk", ASK);
    // The run's answer reaches her, then the question, which goes once the run ends.
    await firm.person.nextWith("I've asked you", 30);
    const question = await firm.person.nextWith(MAIL.to, 30);
    expect(question.text).toContain(MAIL.subject);
    expect(question.text).toContain(MAIL.body);
    const payload = { from: DANA, subject: "Signed lease 4B", text: "The 4B lease is signed." };
    await firm.push({ ref: "<signed-4b@harbor.example>", payload });
    await firm.person.nextWith(NEWS, 60);
    expect(firm.mail.callsTo("send_mail")).toEqual([]);
    await firm.person.send("desk", NO);
    await firm.person.nextWith("It stays unsent", 30);

    expect(firm.mail.callsTo("send_mail")).toEqual([]);
    expect(await firm.logged("gate")).toContainEqual({
      gate: harbor.coworker,
      tool: TOOLS.answer,
      state: "free",
      outcome: "refused",
      ms: expect.any(Number),
      why: SHAPE,
    });
    const db = firm.db();
    const answers = db.query("select answer from outbox where kind = 'ask'").all();
    db.close();
    expect(answers).toEqual([{ answer: "no" }]);
  });

  test("a box raises a free call to ask first: harbor's box holds a draft for someone outside the firm, and Rosa's yes saves it once, exactly as shown", async () => {
    const ASK = "Draft the 4B renewal for Dana and for Lee.";
    const INSIDE = { to: DANA, subject: "4B renewal", body: "Hi Dana, here is the renewal." };
    const OUTSIDE = {
      to: "lee.okafor@tidewater.example",
      subject: "4B renewal",
      body: "Hi Lee, here it is.",
    };
    const SAVE = "Yes, save Lee's too.";
    let ask = 0;
    firm.model.on(said(ASK), call("save_draft", INSIDE));
    firm.model.on(answered("save_draft"), call("save_draft", OUTSIDE));
    firm.model.on(answered("save_draft"), (r) => {
      ask = idIn(r.last);
      return say("Dana's draft is saved. Lee is outside the firm, so I've asked you first.");
    });
    firm.model.on(said(SAVE), () => call(TOOLS.answer, { ask, yes: true }));
    // The held call was made in the main conversation, so its outcome steers the run the yes is given in.
    firm.model.on(all(coworkerRun, said(OUTCOME)), say("Lee's draft is saved."));

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("I've asked you first", 30);
    const question = await firm.person.nextWith(OUTSIDE.to, 30);
    expect(question.text).toContain(OUTSIDE.body);
    expect(firm.mail.callsTo("save_draft").map((c) => c.input)).toEqual([INSIDE]);

    await firm.person.send("desk", SAVE);
    await firm.person.nextWith("Lee's draft is saved", 60);
    expect(firm.mail.callsTo("save_draft").map((c) => c.input)).toEqual([INSIDE, OUTSIDE]);
  });

  test("a call held before a restart runs once on Rosa's yes after it, as it was held, with its file's bytes as they were though the file changed since, and its outcome reaches the session that made it", async () => {
    const { sent, text } = await heldFile(firm, "<terms-4b@harbor.example>", 1);
    firm.model.on(all(coworkerRun, said(OUTCOME)), say("Dana has the terms."));
    firm.model.on(answered(TOOLS.answer), say("Sent."));
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

  test("a restart while the yes's call is at the plug runs it no second time, though the coworker gives the yes again", async () => {
    const { sent } = await heldFile(firm, "<terms-4b-again@harbor.example>", 2);
    firm.model.on(answered(TOOLS.answer), say("Dana has the terms already."));
    firm.mail.hold("send_file");

    await firm.person.send("desk", YES);
    await firm.mail.reached("send_file");
    await firm.stop();
    firm.mail.release("send_file");
    await firm.start();

    await firm.person.nextWith("already", 90);
    expect(firm.mail.callsTo("send_file").map((c) => c.input)).toEqual([sent]);
    const again = firm.model.requests.filter(answered(TOOLS.answer)).map((r) => r.last);
    expect(again).toEqual([expect.stringContaining("is not waiting on an answer")]);
  });

  test("a question nobody answers is a no when Rosa's quiet hours begin, the coworker is told, and a later yes runs nothing", async () => {
    const ASK = "Send Dana the 4B renewal terms, please.";
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
    firm.model.on(said(YES), () => call(TOOLS.answer, { ask, yes: true }));
    firm.model.on(answered(TOOLS.answer), say("That ask has lapsed."));

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("I've asked you", 30);
    await firm.person.nextWith(MAIL.to, 30);
    // Quiet hours from the next minute in Rosa's zone, for an hour.
    await firm.reinstall((setup) => {
      setup.settings.quiet = [1 / 60, 1 + 1 / 60].map((h) => clock(setup.zone, h));
    });
    await firm.person.nextWith("quiet hours began", 150);

    await firm.person.send("desk", YES);
    await firm.person.nextWith("lapsed", 30);
    expect(firm.mail.callsTo("send_mail")).toEqual([]);
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

  test("harbor's box holds a PDF its mail never handed the coworker for Rosa's yes and tells her and the coworker why; a PDF it handed goes through with no ask, after a restart too", async () => {
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
    firm.model.on(said(AGAIN), store("4B lease.pdf", HANDED));
    firm.model.on(answered("store_file"), say("Stored again."));
    await firm.person.send("desk", AGAIN);
    await firm.person.nextWith("Stored again.", 90);
    expect(firm.mail.callsTo("store_file").map((c) => c.input)).toEqual([
      { name: "4B lease.pdf", file: b64(LEASE) },
      { name: "4B lease.pdf", file: b64(LEASE) },
    ]);
  });
});

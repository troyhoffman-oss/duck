import { expect, test } from "bun:test";
import {
  all,
  answered,
  call,
  coworkerRun,
  E2E,
  held,
  idIn,
  JOB_CALLS,
  jobRun,
  lacks,
  said,
  say,
  shows,
  sorter,
  startFirm,
  TOOLS,
  until,
} from "../kit";

const REF = "<renewal-4b@harbor.example>";
const SUBJECT = "Lease renewal for 4B";
const BRIEF =
  "Draft Rosa's reply to Dana Reyes about renewing 4B. Done means: the reply names the new rent of $1,900 a month from January 1.";
const REPORT = [
  "## Blocked on me",
  "Nothing.",
  "## Changed",
  'Wrote the reply: "Hi Dana, the renewal for 4B is $1,900 a month from January 1."',
  "## Found",
  "The rent roll lists 4B at $1,850 today.",
].join("\n");
const GRADE = "Done means 1 is met: the reply names $1,900 a month from January 1.";
const TELL = "Dana's 4B renewal reply is drafted, checked and in Rosa's Drafts.";
const MESSAGE = "Dana asked about renewing 4B. A reply at $1,900 a month from January 1 is in your Drafts.";
const ASK =
  "Two things: go through the whole 4B lease file for its dates, and find when the boiler was last serviced.";
const LONG = "Reading the 4B lease file";
const SHORT = "Finding the boiler's last service";
const LONG_BRIEF =
  "List every date in the 4B lease file with its page. Done means: each date is listed with its page.";
const SHORT_BRIEF = "Find when the boiler was last serviced. Done means: the date and who serviced it.";
const SERVICED = "The boiler was last serviced on March 3 by Harbor Boiler Co.";
const UNDER_WAY = "Both are under way: the lease file and the boiler's service.";
const BOILER = `${SERVICED} The lease file is still being read.`;
const STOP = "Stop the lease one, I found the dates myself.";
const STOPPED = "Stopped the lease file read.";

test(
  "a mail becomes an item, a job, a check and one message",
  async () => {
    await using firm = await startFirm();
    let item = 0;
    firm.model.on(all(sorter, shows(SUBJECT)), say("wake: a tenant asks about her renewal"));
    firm.model.on(
      all(coworkerRun, shows(SUBJECT)),
      call(TOOLS.writeItem, {
        title: "Reply to Dana about the 4B renewal",
        next: "Draft the reply",
        links: [{ kind: "mail_thread", ref: REF }],
      }),
    );
    firm.model.on(answered(TOOLS.writeItem), (r) => {
      item = idIn(r.last);
      return call(TOOLS.startJob, {
        item_id: item,
        brief: BRIEF,
        check: true,
        check_reason: "It goes to a tenant, and the sign says those are checked.",
      });
    });
    firm.model.on(answered(TOOLS.startJob), say("The draft is under way."));
    firm.model.on(all(jobRun, shows(BRIEF), lacks("## Changed")), say(REPORT));
    firm.model.on(all(jobRun, shows(BRIEF), shows("## Changed")), say(GRADE));
    firm.model.on(
      all(coworkerRun, shows("## Changed")),
      call("save_draft", {
        to: "dana.reyes@harbor.example",
        subject: `Re: ${SUBJECT}`,
        body: "Hi Dana, the renewal for 4B is $1,900 a month from January 1.",
      }),
    );
    firm.model.on(answered("save_draft"), () => call(TOOLS.tell, { text: TELL, item_id: item }));
    firm.model.on(answered(TOOLS.tell), say("Rosa will hear about it."));
    firm.model.on(all(coworkerRun, said(TELL)), say(MESSAGE));

    const pushed = await firm.push({
      ref: REF,
      payload: {
        from: "Dana Reyes <dana.reyes@harbor.example>",
        subject: SUBJECT,
        text: "Hi Rosa, could you send me the renewal terms for 4B?",
      },
    });
    expect(pushed).toEqual({ status: 202, body: { duplicate: false } });

    expect((await firm.person.next(120)).text).toBe(MESSAGE);
    await firm.person.quiet(10);
    expect(firm.mail.callsTo("save_draft")).toHaveLength(1);
    const checked = firm.model.requests.find(all(jobRun, shows("## Changed")));
    expect(checked).toBeDefined();
    expect(firm.mail.callsTo("save_draft")[0]?.at).toBeGreaterThan(checked?.started as number);

    using db = firm.db();
    expect(db.query("select title from items where id = ?").all(item)).toEqual([
      { title: "Reply to Dana about the 4B renewal" },
    ]);
    expect(db.query("select kind from links where item_id = ? and ref = ?").all(item, REF)).toEqual([
      { kind: "mail_thread" },
    ]);
    expect(db.query('select check_reason from jobs where item_id = ? and "check"').all(item)).toHaveLength(1);

    // duck linked what the run made, the job and the draft on its thread, with no word from the coworker.
    expect(
      db
        .query("select kind, ref from links where item_id = ? and added_by = 'code' order by rowid")
        .all(item),
    ).toMatchObject([
      { kind: "job" },
      { kind: "draft", ref: "d-1" },
      { kind: "mail_thread", ref: "thread-d-1" },
    ]);
    await firm.step();

    // Rosa sends the draft. The mail sent on its thread comes to the item with no sorter call, and the next
    // time she writes, her conversation is shown it on the item's log, though only the item's own run had it.
    const SENT = {
      ref: "<sent-4b@harbor.example>",
      about: "thread-d-1",
      payload: { kind: "mail sent", to: "dana.reyes@harbor.example", subject: `Re: ${SUBJECT}` },
    };
    const [ASKED, YES] = ["Did my reply to Dana go out?", "Yes, you sent it."];
    firm.model.on(all(coworkerRun, said(SENT.ref), lacks(ASKED)), say("Rosa sent the reply."));
    firm.model.on(all(coworkerRun, said(ASKED), said(JSON.stringify(SENT.payload))), say(YES));
    expect(await firm.push(SENT)).toEqual({ status: 202, body: { duplicate: false } });
    await until(
      "the sent mail's run",
      () => !!db.query("select 1 from inbox where ref = ? and state = 'done'").get(SENT.ref),
      60,
      firm.trouble,
    );
    expect(db.query("select item_id from inbox where ref = ?").get(SENT.ref)).toEqual({ item_id: item });
    expect(firm.model.requests.some(all(sorter, shows(SENT.ref)))).toBe(false);
    await firm.person.send("desk", ASKED);
    expect((await firm.person.next(60)).text).toBe(YES);
  },
  E2E,
);

test(
  "two jobs work at once, the coworker sees where each stands, and a stopped job never ends",
  async () => {
    await using firm = await startFirm();
    let item = 0;
    const started: string[] = [];
    let listed = "";
    let stopped = "";
    const job = (title: string, brief: string) =>
      call(TOOLS.startJob, {
        title,
        item_id: item,
        brief,
        check: false,
        check_reason: "It stays with Rosa, and nothing goes out.",
      });
    firm.model.on(
      all(coworkerRun, said(ASK)),
      call(TOOLS.writeItem, { title: "4B lease dates and the boiler's service", next: "Read and look up" }),
    );
    firm.model.on(answered(TOOLS.writeItem), (r) => {
      item = idIn(r.last);
      return job(LONG, LONG_BRIEF);
    });
    firm.model.on(answered(TOOLS.startJob), (r) => {
      started.push(r.last);
      return job(SHORT, SHORT_BRIEF);
    });
    firm.model.on(answered(TOOLS.startJob), (r) => {
      started.push(r.last);
      return say(UNDER_WAY);
    });
    firm.model.on(all(jobRun, shows(LONG_BRIEF)), held("long", say("## Found\nThe lease names no dates.")));
    firm.model.on(all(jobRun, shows(SHORT_BRIEF)), held("short", say(`## Found\n${SERVICED}`)));
    firm.model.on(all(coworkerRun, said(SERVICED)), call("jobs"));
    firm.model.on(answered("jobs"), (r) => {
      listed = r.last;
      return say(BOILER);
    });
    firm.model.on(all(coworkerRun, said(STOP)), call("stop_job", { title: "LEASE FILE" }));
    firm.model.on(answered("stop_job"), (r) => {
      stopped = r.last;
      return say(STOPPED);
    });

    await firm.person.send("desk", ASK);
    await firm.person.nextWith(UNDER_WAY, 120);
    expect(started[0]).toContain(`"${LONG}" is started. It starts now.`);
    expect(started[1]).toContain(`"${SHORT}" is started. It starts now, beside 1 other job.`);
    await firm.model.reached("long");
    await firm.model.reached("short");
    firm.model.release("short");

    await firm.person.nextWith(BOILER, 120);
    const long = firm.model.requests.find(all(jobRun, shows(LONG_BRIEF)));
    expect(long?.ended).toBeNull();
    expect(listed).toContain(`- "${LONG}", on item ${item}: working since`);
    expect(listed).toContain(`- "${SHORT}", on item ${item}: done since`);

    await firm.person.send("desk", STOP);
    await firm.person.nextWith(STOPPED, 120);
    expect(stopped).toContain(`"${LONG}" is stopped, and nothing more comes back from it.`);
    firm.model.release("long");
    await firm.person.quiet(10);

    using db = firm.db();
    expect(db.query("select title, state from jobs order by id").all()).toEqual([
      { title: LONG, state: "stopped" },
      { title: SHORT, state: "done" },
    ]);
    const ends = db.query<{ ref: string }, []>("select ref from inbox where source = 'job'").all();
    expect(ends.map((e) => e.ref.startsWith(`"${SHORT}", round 1`))).toEqual([true]);
    expect(firm.model.requests.some((r) => r.has("delegate") || r.has("manage_extensions"))).toBe(false);
    await firm.step();

    // A worker that keeps calling is cut off at the job's cap of model calls. Its round ends unverified, the
    // coworker is told which cap and the figures and tells Rosa, and the item's log says the same.
    const [SEARCH, SEARCH_BRIEF] = [
      "Boiler mail",
      "List every mail about the boiler. Done means: each is listed.",
    ];
    const ASK_SEARCH = "Find every mail about the boiler.";
    const CAPPED = "The boiler mail search hit its limit before it finished; nothing it found is verified.";
    const WORDS = new RegExp(
      `The worker was cut at its cap of ${JOB_CALLS} model calls, after ${JOB_CALLS} model calls costing \\$\\d+\\.\\d\\d\\. The job's work so far is unverified\\.`,
    );
    firm.model.on(all(coworkerRun, said(ASK_SEARCH)), job(SEARCH, SEARCH_BRIEF));
    firm.model.on(answered(TOOLS.startJob), say("Searching."));
    // Each call asks for the next page: goose itself ends a run that repeats one call unchanged.
    let page = 0;
    firm.model.on(
      all(jobRun, shows(SEARCH_BRIEF)),
      () => call("find_mail", { query: `boiler, page ${++page}` }),
      { times: Number.POSITIVE_INFINITY },
    );
    firm.model.on(all(coworkerRun, said("was cut at its cap of")), say(CAPPED));

    await firm.person.send("desk", ASK_SEARCH);
    await firm.person.nextWith(CAPPED, 120);
    await firm.person.quiet(5);
    expect(firm.model.requests.filter(all(jobRun, shows(SEARCH_BRIEF)))).toHaveLength(JOB_CALLS);
    const end = db
      .query<{ payload: string }, [string]>("select payload from inbox where source = 'job' and ref like ?")
      .get(`"${SEARCH}", round 1%`);
    expect(JSON.parse(end?.payload ?? "{}").cut).toMatch(WORDS);
    expect(db.query("select state from jobs where title = ?").get(SEARCH)).toEqual({ state: "done" });
    const logged = db
      .query<{ text: string }, [number]>(
        "select text from log where item_id = ? and by = 'code' order by rowid",
      )
      .all(item)
      .at(-1)?.text;
    expect(logged).toStartWith(`Job "${SEARCH}" ended round 1, not checked. `);
    expect(logged).toMatch(WORDS);
  },
  E2E,
);

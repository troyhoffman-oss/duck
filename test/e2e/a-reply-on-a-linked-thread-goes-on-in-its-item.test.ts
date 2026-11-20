import { expect, test } from "bun:test";
import {
  all,
  answered,
  call,
  coworkerRun,
  E2E,
  held,
  idIn,
  jobRun,
  said,
  say,
  shows,
  sorter,
  startFirm,
  TOOLS,
  until,
} from "../kit";

const THREAD = "thread-renewal-4b";
const MEETING = "mtg-4b-walkthrough";
const FIRST = {
  ref: "<renewal-4b-1@harbor.example>",
  about: THREAD,
  payload: {
    from: "Dana Reyes <dana.reyes@harbor.example>",
    subject: "Lease renewal for 4B",
    text: "Hi Rosa, could you send me the renewal terms for 4B?",
  },
};
const SECOND = {
  ref: "<renewal-4b-2@harbor.example>",
  about: THREAD,
  payload: {
    from: "Dana Reyes <dana.reyes@harbor.example>",
    subject: "Re: Lease renewal for 4B",
    text: "Also, could the new lease start on February 1?",
  },
};
const MOVED = { id: "chg-4b-1", meeting: MEETING, title: "4B walk-through with Dana moved to Friday 10 am" };

test(
  "a reply on a linked thread goes on in its item: a second mail on the thread, and a change to a linked meeting, reach the item with no sorter call and in the item's session",
  async () => {
    await using firm = await startFirm();
    let item = 0;
    firm.model.on(all(sorter, shows(FIRST.payload.text)), say("wake: a tenant asks about her renewal"));
    firm.model.on(
      all(coworkerRun, shows(FIRST.payload.text), shows(THREAD)),
      call(TOOLS.writeItem, {
        title: "Send Dana the 4B renewal terms",
        links: [
          { kind: "mail_thread", ref: THREAD },
          { kind: "meeting", ref: MEETING },
        ],
      }),
    );
    firm.model.on(answered(TOOLS.writeItem), (r) => {
      item = idIn(r.last);
      return say("On the list.");
    });
    firm.model.on(all(coworkerRun, said(SECOND.payload.text)), say("Noted on the item."));
    firm.model.on(all(coworkerRun, said(MOVED.title)), say("Noted the new time."));

    const done = (ref: string) => {
      using db = firm.db();
      return db.query("select 1 from inbox where ref = ? and state = 'done'").all(ref).length > 0;
    };
    expect(await firm.push(FIRST)).toEqual({ status: 202, body: { duplicate: false } });
    await until("the first mail's run", () => item > 0 && done(FIRST.ref), 60, firm.trouble);

    expect(await firm.push(SECOND)).toEqual({ status: 202, body: { duplicate: false } });
    expect(await firm.push(SECOND)).toEqual({ status: 202, body: { duplicate: true } });
    await until("the second mail's run", () => done(SECOND.ref), 60, firm.trouble);

    firm.calendar.rows.push(MOVED);
    await until("the meeting change's run", () => done(MOVED.id), 60, firm.trouble);

    for (const text of [SECOND.payload.text, MOVED.title])
      expect(firm.model.requests.some(all(sorter, shows(text)))).toBe(false);
    const later = firm.model.requests.filter((r) =>
      [SECOND.payload.text, MOVED.title].some((t) => said(t)(r)),
    );
    expect(later).toHaveLength(2);
    expect(later.every((r) => r.shows(FIRST.payload.text))).toBe(true);

    using db = firm.db();
    const rows = db
      .query<{ ref: string; about: string | null; item_id: number; session: string }, []>(
        "select ref, about, item_id, session from inbox where source in ('mail', 'calendar') order by id",
      )
      .all();
    expect(rows.map((r) => [r.ref, r.about, r.item_id])).toEqual([
      [FIRST.ref, THREAD, item],
      [SECOND.ref, THREAD, item],
      [MOVED.id, MEETING, item],
    ]);
    expect(new Set(rows.map((r) => r.session)).size).toBe(1);
  },
  E2E,
);

test(
  "a mail on an item last worked in the main conversation, while Rosa's turn is open, runs in a session of its own and leaves her turn alone",
  async () => {
    await using firm = await startFirm();
    const ASK = "Put Dana's 4B renewal on the list, on her thread, and have the terms looked up.";
    const BRIEF = "Look up the renewal terms for 4B in the rent roll.";
    const REPORT = "Renewal terms for 4B are 1900 a month from January 1";
    const [STARTED, TERMS] = ["It is on the list and the terms are being looked up.", `${REPORT}.`];
    let item = 0;
    firm.model.on(
      all(coworkerRun, said(ASK)),
      call(TOOLS.writeItem, {
        title: "Send Dana the 4B renewal terms",
        links: [{ kind: "mail_thread", ref: THREAD }],
      }),
    );
    firm.model.on(answered(TOOLS.writeItem), (r) => {
      item = idIn(r.last);
      return call(TOOLS.startJob, { item_id: item, brief: BRIEF, check: false, check_reason: "A lookup." });
    });
    firm.model.on(answered(TOOLS.startJob), say(STARTED));
    firm.model.on(all(jobRun, shows(BRIEF)), held("job", say(REPORT)));
    firm.model.on(all(coworkerRun, said(REPORT)), say(TERMS));

    await firm.person.send("desk", ASK);
    expect((await firm.person.next(60)).text).toBe(STARTED);
    firm.model.release("job");
    expect((await firm.person.next(120)).text).toBe(TERMS);
    const main = () => {
      using db = firm.db();
      return db.query<{ session: string }, []>("select session from inbox where source = 'desk'").get()
        ?.session;
    };
    const lastOnItem = () => {
      using db = firm.db();
      return db
        .query<{ source: string; session: string }, [number]>(
          "select source, session from inbox where item_id = ? and session is not null order by id desc limit 1",
        )
        .get(item);
    };
    expect(lastOnItem()).toEqual({ source: "job", session: main() as string });
    await firm.step();

    const [NEXT, LINE, NOTED] = [
      "What else is on today?",
      "Two viewings this afternoon.",
      "Noted on the item.",
    ];
    firm.model.on(all(coworkerRun, said(NEXT)), held("open", say(LINE)));
    firm.model.on(all(coworkerRun, said(SECOND.payload.text)), say(NOTED));
    const event = () => {
      using db = firm.db();
      return db
        .query<{ state: string; session: string | null }, [string]>(
          "select state, session from inbox where ref = ?",
        )
        .get(SECOND.ref);
    };
    await firm.person.send("desk", NEXT);
    await firm.model.reached("open");
    expect(await firm.push(SECOND)).toEqual({ status: 202, body: { duplicate: false } });
    await until("the mail's run to begin", () => !!event()?.session, 60, firm.trouble);
    firm.model.release("open");
    expect((await firm.person.next(60)).text).toBe(LINE);
    await until("the mail's run", () => event()?.state === "done", 60, firm.trouble);
    await firm.person.quiet(5);
    expect(event()?.session).not.toBe(main());
    expect(await firm.logs()).not.toContain("stopped a run");
    await firm.step();

    const LATER = "Anything from Dana?";
    let offered: boolean[] = [];
    firm.model.on(all(coworkerRun, said(LATER)), (r) => {
      offered = [r.has(TOOLS.answer), r.has(TOOLS.tell)];
      return say("Nothing new.");
    });
    await firm.person.send("desk", LATER);
    expect((await firm.person.next(60)).text).toBe("Nothing new.");
    expect(offered).toEqual([true, false]);
  },
  E2E,
);

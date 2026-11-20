import { expect, test } from "bun:test";
import {
  all,
  answered,
  call,
  coworkerRun,
  E2E,
  type Firm,
  idIn,
  type ModelRequest,
  said,
  say,
  shows,
  sorter,
  startFirm,
  TOOLS,
  until,
} from "../kit";

const THREAD = "thread-renewal-4b";
const RENT = {
  ref: "<rent-2a@harbor.example>",
  payload: { from: "payments@harbor.example", subject: "Rent paid for 2A", text: "Payment received." },
};
const ASKED = {
  ref: "<renewal-4b-1@harbor.example>",
  about: THREAD,
  payload: {
    from: "Dana Reyes <dana.reyes@harbor.example>",
    subject: "Lease renewal for 4B",
    text: "Hi Rosa, could you send me the renewal terms for 4B?",
  },
};
const SENT = {
  ref: "<renewal-4b-2@harbor.example>",
  about: THREAD,
  payload: {
    from: "Rosa Alvarez <rosa@harbor.example>",
    to: "dana.reyes@harbor.example",
    subject: "Re: Lease renewal for 4B",
    text: "Hi Dana, the renewal for 4B is $1,900 a month from January 1.",
  },
};
const TITLE = "Send Dana the 4B renewal terms";
const DRAFTED = "A reply to Dana with the 4B renewal terms is waiting in your Drafts.";
const CLOSED = "Rosa sent Dana the renewal terms herself.";
const TOLD = "Dana has the 4B renewal terms: you sent them to her yourself.";
const WINDOW = 30;

/**
 * Brings Rosa's window to open on a tell that waited, and returns the main conversation's request for it with
 * the tell's row. A paid rent's message opens the window; Dana's mail becomes an item and a tell about its
 * draft, which waits; Rosa's own reply on the thread is run on the item and closes it with a log line.
 */
async function waited(firm: Firm) {
  let item = 0;
  firm.model.on(all(sorter, shows(RENT.payload.subject)), say("wake: a payment"));
  firm.model.on(
    all(coworkerRun, said(RENT.payload.text)),
    call(TOOLS.tell, { text: "2A paid November's rent." }),
  );
  firm.model.on(all(coworkerRun, said("2A paid")), say("2A paid November's rent."));
  firm.model.on(all(sorter, shows(ASKED.payload.text)), say("wake: a tenant asks about her renewal"));
  firm.model.on(
    all(coworkerRun, said(ASKED.payload.text)),
    call(TOOLS.writeItem, { title: TITLE, links: [{ kind: "mail_thread", ref: THREAD }] }),
  );
  firm.model.on(answered(TOOLS.writeItem), (r) => {
    item = idIn(r.last);
    return call(TOOLS.tell, { text: DRAFTED, item_id: item });
  });
  firm.model.on(answered(TOOLS.tell), say("Told."), { times: 2 });
  firm.model.on(all(coworkerRun, said(SENT.payload.text)), () =>
    call(TOOLS.writeItem, { id: item, state: "done", log: CLOSED }),
  );
  firm.model.on(answered(TOOLS.writeItem), say("Closed."));
  firm.model.on(all(coworkerRun, said(DRAFTED)), say(TOLD), { times: Number.POSITIVE_INFINITY });

  const done = (ref: string) => {
    using db = firm.db();
    return db.query("select 1 from inbox where ref = ? and state = 'done'").all(ref).length > 0;
  };
  await firm.push(RENT);
  await firm.person.nextWith("2A paid", 60);
  await firm.push(ASKED);
  await until("Dana's mail's run", () => item > 0 && done(ASKED.ref), 60, firm.trouble);
  await firm.push(SENT);
  await until("Rosa's reply's run", () => done(SENT.ref), 60, firm.trouble);
  expect(firm.model.requests.some(said(DRAFTED))).toBe(false);

  await until("the tells run", () => firm.model.requests.some(said(DRAFTED)), WINDOW + 30, firm.trouble);
  using db = firm.db();
  const row = db
    .query<{ created_at: string; item_id: number }, [string]>(
      "select created_at, item_id from outbox where text = ?",
    )
    .get(DRAFTED);
  return { request: firm.model.requests.find(said(DRAFTED)) as ModelRequest, row, item };
}

test(
  "a tell that waited for the person's window is shown with when it was written, its item as it stands now and what was logged on it since",
  async () => {
    await using firm = await startFirm({ onePer: `${WINDOW}s` });
    const { request, row, item } = await waited(firm);

    expect(row?.item_id).toBe(item);
    expect(request.last).toContain(`${row?.created_at}: ${DRAFTED}`);
    expect(request.last).toContain(`${item}. ${TITLE} · done`);
    expect(request.last).toContain(`coworker: ${CLOSED}`);
    await firm.person.nextWith(TOLD, 30);
  },
  E2E,
);

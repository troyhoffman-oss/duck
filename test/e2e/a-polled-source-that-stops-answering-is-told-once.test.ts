import { expect, test } from "bun:test";
import {
  all,
  answered,
  call,
  coworkerRun,
  E2E,
  harbor,
  type ModelRequest,
  said,
  say,
  shows,
  sorter,
  startFirm,
  TOOLS,
  until,
} from "../kit";

const ASK = "Is my calendar clear today?";
const HICCUP = "the calendar hiccuped once";
const EXPIRED = "the sign-in to Rosa's calendar expired";
/** What duck says of a plug's error whose text is not JSON, since that text may be anyone's words. */
const NOT_JSON = "the plug answered with an error that is not JSON";

/** When the source went down, as the broken event the coworker is shown names it. */
const since = (r: ModelRequest | undefined) => /calendar down since (\S+?),/.exec(r?.last ?? "")?.[1];

test(
  "a polled source that stops answering is told once: one failed poll is only logged; three in a row tell the person once, with the plug, since when and the error's words; when it answers again what it lists arrives; and a later time down is told again",
  async () => {
    await using firm = await startFirm();
    firm.model.on(said(ASK), say("Nothing on it today."));
    await firm.person.send("desk", ASK);
    await firm.person.nextWith("Nothing on it", 30);
    await firm.step();

    let polls = 0;
    firm.calendar.answer("list_events", () => {
      if (++polls === 1) throw new Error(HICCUP);
      return firm.calendar.rows;
    });
    await until("a failed poll and two that answer", () => polls >= 3, 30, firm.trouble);
    await firm.person.quiet(3);
    const failed = (await firm.logs())
      .split("\n")
      .filter((l) => l.includes(`the poll of plug calendar for ${harbor.coworker} failed: `));
    expect(failed.length).toBe(1);
    expect(failed[0]).toContain(HICCUP);
    await firm.step();

    firm.model.on(
      all(coworkerRun, said(EXPIRED)),
      say("Your calendar has stopped answering me: its sign-in expired."),
    );
    firm.calendar.answer("list_events", () => {
      throw new Error(EXPIRED);
    });
    await firm.person.nextWith("stopped answering", 60);
    const down = firm.model.requests.find(all(coworkerRun, said(EXPIRED)));
    expect(down?.last).toContain('"plug":"calendar"');
    expect(Date.parse(since(down) ?? "")).toBeLessThan(Date.now());
    firm.calendar.rows.push({ id: "ev-lender-9", title: "Lender call moved to 3 pm Friday" });
    const calls = firm.calendar.callsTo("list_events").length;
    await firm.person.quiet(5);
    expect(firm.calendar.callsTo("list_events").length).toBeGreaterThan(calls + 2);

    firm.model.on(all(sorter, shows("Lender call moved")), say("wake: a calendar change"));
    firm.model.on(
      all(coworkerRun, shows("Lender call moved")),
      call(TOOLS.tell, { text: "The lender call moved to 3 pm Friday." }),
    );
    firm.model.on(answered(TOOLS.tell), say("Told."));
    firm.model.on(all(coworkerRun, said("lender call moved")), say("Your lender call is now 3 pm Friday."));
    firm.calendar.answer("list_events", () => firm.calendar.rows);
    await firm.person.nextWith("3 pm Friday", 60);
    await firm.step();

    firm.model.on(
      all(coworkerRun, said(NOT_JSON)),
      say("Your calendar is not answering me again: it sends back an error."),
    );
    const page = "<html><body>401 Unauthorized</body></html>";
    firm.calendar.answer("list_events", () => ({ isError: true, content: [{ type: "text", text: page }] }));
    await firm.person.nextWith("not answering me again", 60);
    const again = firm.model.requests.find(all(coworkerRun, said(NOT_JSON)));
    expect(since(again)).not.toBe(since(down));
    expect(again?.last).not.toContain("Unauthorized");
    await firm.person.quiet(5);
  },
  E2E,
);

test(
  "a polled source whose error's text is JSON is still down: it is told, and its text is not read as rows",
  async () => {
    await using firm = await startFirm();
    firm.model.on(
      all(coworkerRun, said("the plug answered with an error")),
      say("Your calendar is not answering me: it sends back an error."),
    );
    firm.calendar.answer("list_events", () => ({
      isError: true,
      content: [{ type: "text", text: JSON.stringify([{ id: "ev-bogus", title: "Bogus error row" }]) }],
    }));
    await firm.person.nextWith("not answering me", 60);
    expect(firm.model.requests.some(shows("Bogus error row"))).toBe(false);
    await firm.person.quiet(5);
  },
  E2E,
);

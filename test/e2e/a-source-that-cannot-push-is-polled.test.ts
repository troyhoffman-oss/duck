import { expect, test } from "bun:test";
import { all, answered, call, coworkerRun, E2E, said, say, shows, sorter, startFirm, TOOLS } from "../kit";

const ASK = "What can you see on my calendar?";

// harbor's calendar answers its list inside a wrapper here; a list read with no box is polled in
// a-reply-on-a-linked-thread-goes-on-in-its-item.test.ts, where a meeting's change reaches its item.
test(
  "a source that cannot push is polled: a new row its list tool gives, inside a wrapper its box takes off, becomes one message, the poller keeps calling it, and no coworker run is offered it",
  async () => {
    await using firm = await startFirm({ wrapped: true });
    firm.model.on(said(ASK), say("Only what the calendar tells me."));
    firm.model.on(all(sorter, shows("Lender call moved")), say("wake: a calendar change"));
    firm.model.on(
      all(coworkerRun, shows("Lender call moved")),
      call(TOOLS.tell, { text: "The lender call moved to 3 pm Friday." }),
    );
    firm.model.on(answered(TOOLS.tell), say("Told."));
    firm.model.on(all(coworkerRun, said("lender call moved")), say("Your lender call is now 3 pm Friday."));

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("Only what", 30);
    firm.calendar.rows.push({ id: "ev-lender-9", title: "Lender call moved to 3 pm Friday" });
    await firm.person.nextWith("3 pm Friday", 60);
    const listed = firm.calendar.callsTo("list_events").length;
    await firm.person.quiet(5);
    expect(firm.calendar.callsTo("list_events").length).toBeGreaterThan(listed);

    const runs = firm.model.requests.filter(coworkerRun);
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) expect(run.has("list_events")).toBe(false);
  },
  E2E,
);

test(
  "a poll whose answer is not JSON is logged with what kind of answer it was, and none of its text",
  async () => {
    await using firm = await startFirm();
    const PAGE = "<html><body>502 Bad Gateway</body></html>";
    firm.calendar.answer("list_events", () => PAGE);
    const polls = async () =>
      (await firm.logs()).split("\n").filter((l) => l.includes("the poll of plug calendar for "));
    /** Waits up to 30 s for duck to log the poll's failure as `kind`, and returns every poll line it logged. */
    const logged = async (kind: string) => {
      const line = ` failed: the plug answered with ${kind} that is not JSON`;
      for (const end = Date.now() + 30_000; ; await Bun.sleep(500)) {
        const lines = await polls();
        if (lines.some((l) => l.includes(line))) return lines;
        if (Date.now() > end) throw new Error(`waited 30 s for "${line}" in duck's log`);
      }
    };
    for (const l of await logged("a result")) expect(l).not.toContain("Bad Gateway");
    firm.calendar.answer("list_events", () => ({ isError: true, content: [{ type: "text", text: PAGE }] }));
    for (const l of await logged("an error")) expect(l).not.toContain("Bad Gateway");
  },
  E2E,
);

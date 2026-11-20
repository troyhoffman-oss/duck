import { expect, test } from "bun:test";
import { all, coworkerRun, E2E, say, shows, sorter, startFirm, until } from "../kit";

/** A mail from outside, as harbor's mail plug pushes it. */
const mail = (ref: string, subject: string, text: string) => ({
  ref,
  payload: { from: "someone@elsewhere.example", subject, text },
});

test(
  "sorter: in observe, noise still wakes the coworker and the answer is logged beside its run",
  async () => {
    await using firm = await startFirm({ sorter: "observe" });
    firm.model.on(all(sorter, shows("Five tips for landlords")), say("noise: a newsletter"));
    firm.model.on(all(coworkerRun, shows("Five tips for landlords")), say("Nothing to do: a newsletter."));

    await firm.push(mail("<tips@news.example>", "Five tips for landlords", "Our November newsletter."));
    await until("the coworker's run", () => firm.model.requests.some(coworkerRun), 60, firm.trouble);
    const db = firm.db();
    const logged = db
      .query(
        `select answer from sorter join inbox on inbox.id = sorter.event
          join runs on exists (select 1 from json_each(runs.events) where value = sorter.event) where ref = ?`,
      )
      .all("<tips@news.example>");
    db.close();
    expect(logged).toEqual([{ answer: "noise" }]);
    await firm.person.quiet(5);
  },
  E2E,
);

test(
  "sorter: an urgent event skips the gap, and two ordinary ones wait it and arrive in one run",
  async () => {
    await using firm = await startFirm({ gap: "20s" });
    firm.model.on(all(sorter, shows("Water leak")), say("urgent: a leak in a unit"));
    firm.model.on(all(sorter, shows("Rent paid")), say("wake: a payment"), { times: 2 });
    firm.model.on(all(coworkerRun, shows("Water leak")), say("Nothing to do: the plumber is on it."));
    firm.model.on(
      all(coworkerRun, shows("Rent paid for 2A"), shows("Rent paid for 5B")),
      say("Nothing to do: both paid."),
    );
    const leakRun = all(coworkerRun, shows("Water leak"));
    const rentRun = all(coworkerRun, shows("Rent paid"));

    await firm.push(
      mail("<leak-3c@harbor.example>", "Water leak in 3C", "Water is coming through the ceiling."),
    );
    await until("the leak's run, inside the gap", () => firm.model.requests.some(leakRun), 15, firm.trouble);

    const pushed = performance.now();
    await firm.push(mail("<rent-2a@harbor.example>", "Rent paid for 2A", "Payment received."));
    await firm.push(mail("<rent-5b@harbor.example>", "Rent paid for 5B", "Payment received."));
    await until("the rent run", () => firm.model.requests.some(rentRun), 60, firm.trouble);
    const runs = firm.model.requests.filter(rentRun);
    expect(runs.every((r) => r.shows("Rent paid for 2A") && r.shows("Rent paid for 5B"))).toBe(true);
    expect((runs[0]?.started ?? 0) - pushed).toBeGreaterThan(19_000);
    await firm.person.quiet(5);
  },
  E2E,
);

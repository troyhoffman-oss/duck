import { test } from "bun:test";
import { all, answered, call, coworkerRun, E2E, say, shows, sorter, startFirm, TOOLS } from "../kit";

/** A mail from outside, as harbor's mail plug pushes it. */
const mail = (ref: string, subject: string, text: string) => ({
  ref,
  payload: { from: "someone@elsewhere.example", subject, text },
});

test(
  "silence: non-urgent messages keep to the person's one-message limit",
  async () => {
    await using firm = await startFirm({ onePer: "20s" });
    for (const [subject, tell] of [
      ["Rent paid for 2A", "2A paid November's rent."],
      ["Rent paid for 5B", "5B paid November's rent."],
    ] as const) {
      firm.model.on(all(sorter, shows(subject)), say("wake: a payment"));
      firm.model.on(all(coworkerRun, shows(subject)), call(TOOLS.tell, { text: tell }));
      firm.model.on(all(answered(TOOLS.tell), shows(subject)), say("Told."));
    }
    firm.model.on(
      coworkerRun,
      (r) => say(r.shows("5B paid") ? "5B paid November's rent." : "2A paid November's rent."),
      {
        times: Number.POSITIVE_INFINITY,
      },
    );

    await firm.push(mail("<rent-2a@harbor.example>", "Rent paid for 2A", "Payment received."));
    await firm.person.nextWith("2A paid", 60);
    await firm.push(mail("<rent-5b@harbor.example>", "Rent paid for 5B", "Payment received."));
    await firm.person.quiet(10);
    await firm.person.nextWith("5B paid", 30);
  },
  E2E,
);

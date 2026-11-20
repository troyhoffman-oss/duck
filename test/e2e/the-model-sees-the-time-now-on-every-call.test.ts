import { expect, test } from "bun:test";
import { answered, call, E2E, type ModelRequest, said, say, startFirm } from "../kit";

const ASK = "Anything new in my mail?";

/** Each time the turn-context blocks in `text` give, in order, as milliseconds since the epoch. */
const times = (text: string) =>
  [...text.matchAll(/<current-time>(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d:\d\d)<\/current-time>/g)].map(
    ([, day, time, offset]) => Date.parse(`${day}T${time}${offset}`),
  );

test(
  "the model sees the time now on every call: a run's first call has goose's one block, a later call after a tool call that took past the minute shows a later time in its last message, and blocks do not pile up",
  async () => {
    await using firm = await startFirm();
    firm.model.on(said(ASK), call("find_mail", { query: "new" }));
    firm.model.on(answered("find_mail"), call("find_mail", { query: "Dana" }));
    firm.model.on(answered("find_mail"), say("Nothing new today."));
    firm.mail.hold("find_mail");

    await firm.person.send("desk", ASK);
    await firm.mail.reached("find_mail");
    // goose's block is to the minute, so the call is held into the next one.
    await Bun.sleep(61_000 - (Date.now() % 60_000));
    firm.mail.release("find_mail");
    await firm.person.nextWith("Nothing new today.", 60);

    const [first, later, last] = firm.model.requests.filter((r) => r.has("find_mail")) as ModelRequest[];
    /** The times the last message of request `r` gives. */
    const now = (r?: ModelRequest) => times(JSON.stringify(r?.messages.at(-1)?.content ?? ""));
    const [start] = times(first?.shown ?? "");
    expect(times(first?.shown ?? "")).toHaveLength(1);
    expect(now(later)).toHaveLength(1);
    expect((now(later)[0] ?? 0) - (start ?? 0)).toBeGreaterThanOrEqual(60_000);
    expect(times(last?.shown ?? "")).toHaveLength(2);
  },
  E2E,
);

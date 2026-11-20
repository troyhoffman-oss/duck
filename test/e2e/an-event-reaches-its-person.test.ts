import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  all,
  answered,
  call,
  coworkerRun,
  E2E,
  harbor,
  said,
  say,
  second,
  shows,
  sorter,
  startFirm,
  until,
} from "../kit";
import type { When } from "../kit/model";

const ASK = "Anything from Dana today?";
/** Mail for the second person, as harbor's mail service pushes it for the whole firm. */
const RENEWAL = {
  ref: "<renew-7c@harbor.example>",
  person: second.person,
  payload: { from: "dana.reyes@harbor.example", subject: "7C lease renewal", text: "The 7C tenant renews." },
};
const FORGED = {
  ref: "<wire@elsewhere.example>",
  person: second.person,
  payload: { from: "someone@elsewhere.example", subject: "Wire the deposit", text: "Send it today." },
};
const STRANGER = {
  ref: "<stranger@harbor.example>",
  person: "nobody",
  payload: { from: "dana.reyes@harbor.example", subject: "Keys for 2B", text: "Left at the desk." },
};

/** A request from coworker `name`, whose harness text names it. */
const from =
  (name: string): When =>
  (r) =>
    r.system.includes(`You are ${name},`);

test(
  "an event reaches its person: a signed event wakes only its person's coworker, a badly signed one wakes nobody, one for a person with no coworker is answered 404 and logged, and each coworker calls the plug as its own person",
  async () => {
    await using firm = await startFirm({ second: true, signed: true });
    firm.model.on(all(sorter, shows("7C lease renewal")), say("wake: a tenant renews"));
    firm.model.on(all(coworkerRun, shows("7C lease renewal")), call("find_mail", { query: "7C" }));
    firm.model.on(all(from(second.coworker), answered("find_mail")), say("Nothing to tell."));
    firm.model.on(said(ASK), call("find_mail", { query: "Dana" }));
    firm.model.on(all(from(harbor.coworker), answered("find_mail")), say("Nothing new from Dana."));
    const key = (person: string) => `Bearer ${firm.mailKey(person)}`;

    expect(await firm.push(RENEWAL)).toEqual({ status: 202, body: { duplicate: false } });
    expect((await firm.push(FORGED, "not-the-push-key")).status).toBe(401);
    expect((await firm.push(STRANGER)).status).toBe(404);
    await until(
      "the second coworker's call",
      () => firm.mail.callsTo("find_mail").length > 0,
      60,
      firm.trouble,
    );
    expect(firm.mail.callsTo("find_mail")[0]?.headers.get("authorization")).toBe(key(second.person));

    await firm.person.send("desk", ASK);
    await firm.person.nextWith("Nothing new from Dana.", 60);
    expect(firm.mail.callsTo("find_mail")[1]?.headers.get("authorization")).toBe(key(harbor.person));

    const runs = firm.model.requests.filter(all(coworkerRun, shows("7C lease renewal")));
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every(from(second.coworker))).toBe(true);
    for (const text of ["Wire the deposit", "Keys for 2B"])
      expect(firm.model.requests.some(shows(text))).toBe(false);
    const refs = (coworker: string) => {
      using db = firm.db(coworker);
      return db.query<{ ref: string }, []>("select ref from inbox where source = 'mail'").all();
    };
    expect(refs(second.coworker)).toEqual([{ ref: RENEWAL.ref }]);
    expect(refs(harbor.coworker)).toEqual([]);
    // duck's log is the file in the firm's storage folder (SPEC part 1), which holds what it writes to stderr too.
    expect(readFileSync(join(firm.folder, "storage", "duck.log"), "utf8")).toContain(
      `plug mail's event ${STRANGER.ref} for nobody reaches no coworker`,
    );
  },
  E2E,
);

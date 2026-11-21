import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  all,
  answered,
  call,
  E2E,
  type Firm,
  harbor,
  openPage,
  SIGNIN_STRING,
  said,
  say,
  second,
  shows,
  sorter,
  startFirm,
  until,
} from "../kit";
import type { When } from "../kit/model";

setDefaultTimeout(E2E);

/** A run of coworker `name`: its harness names it. */
const of = (name: string): When => shows(`You are ${name},`);
const wren = of(harbor.coworker);
const finch = of(second.coworker);

/** The first address in `text`: the link the gate gives, as the coworker passes it on. */
const linkIn = (text: string) => (/https?:\/\/\S+/.exec(text) as RegExpExecArray)[0];
const stateOf = (link: string) => new URL(link).searchParams.get("state");

// A plug that wants each person's own sign-in at a service (SPEC part 9), connected from a link when the
// firm's server has no public address: the person signs in at the service, lands on duck's page, which shows a
// string, and sends that string to their coworker at a door. The service, the plug, the page's host and the
// person's browser are the kit's. One firm for every step; the steps run in order, each going on from the last.
describe("a person connects their own account to their coworker from a link", () => {
  let firm: Firm;
  /** The first link Rosa was given, the string the page showed her for it, and the link she is given later. */
  let [link, string, again] = ["", "", ""];
  beforeAll(async () => {
    firm = await startFirm({ signin: true, second: true });
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
  }, E2E);
  afterEach(() => firm.step(), E2E);

  /** The files under the firm's storage that hold `value`, by their path there. */
  const holding = (value: string) => {
    const storage = join(firm.folder, "storage");
    const walk = (folder: string): string[] =>
      readdirSync(folder).flatMap((name) => {
        const path = join(folder, name);
        const stat = statSync(path, { throwIfNoEntry: false });
        return stat?.isDirectory() ? walk(path) : stat?.isFile() ? [path] : [];
      });
    return walk(storage)
      .filter((file) => readFileSync(file).includes(value))
      .map((file) => relative(storage, file));
  };
  /** Each code the service issued, as it issued it and as a page string carries it. */
  const codes = () =>
    firm.signin
      .issued()
      .filter((v) => v.startsWith("4/"))
      .flatMap((code) => [code, Buffer.from(code).toString("base64url")]);
  /**
   * That no code the service issued and no string a page showed is in any file of the firm's storage, in what
   * the model was shown or in duck's log this step, and that each token is at most in its coworker's own file of
   * keys and sign-ins, and in neither the model's view nor the log.
   */
  const keptOnlyAsSignIns = async (strings: string[]) => {
    const logs = await firm.logs();
    for (const value of [...codes(), ...strings]) {
      expect(holding(value)).toEqual([]);
      expect(logs).not.toContain(value);
      expect(firm.model.requests.filter((r) => r.shows(value)).length).toBe(0);
    }
    const keys = [`${harbor.coworker}/keys.env`, `${second.coworker}/keys.env`];
    for (const token of firm.signin.issued().filter((v) => !v.startsWith("4/"))) {
      expect(keys).toEqual(expect.arrayContaining(holding(token)));
      expect(logs).not.toContain(token);
      expect(firm.model.requests.filter((r) => r.shows(token)).length).toBe(0);
    }
  };
  const trades = () => firm.signin.tokens.filter((t) => t.grant === "authorization_code");
  const renewals = () => firm.signin.tokens.filter((t) => t.grant === "refresh_token");

  test.failing("Rosa asks for her files before she has connected them: her coworker is offered only the plug's connect tool, and calling it gives a link to pass on, to the firm's app at the service, with her page, the plug's scopes, a state and an S256 challenge", async () => {
    const ASK = "What's in my drive?";
    firm.model.on(all(wren, said(ASK)), call("files__connect"));
    firm.model.on(all(wren, answered("files__connect"), said("has not connected files")), (r) =>
      say(`Sign in here: ${linkIn(r.last)}`),
    );
    await firm.person.send("desk", ASK);
    link = linkIn((await firm.person.nextWith("Sign in here", 60)).text);

    const asked = firm.model.requests.filter(said(ASK));
    expect(asked.length).toBeGreaterThan(0);
    for (const r of asked) {
      expect(r.has("files__connect")).toBe(true);
      expect(r.has("list_files")).toBe(false);
    }
    const url = new URL(link);
    expect(`${url.origin}${url.pathname}`).toBe(firm.signin.authorize.split("?")[0] as string);
    const given = Object.fromEntries(url.searchParams);
    expect(given).toEqual({
      prompt: "consent",
      client_id: firm.signin.client,
      response_type: "code",
      redirect_uri: firm.signin.page,
      scope: "files.read offline_access",
      state: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: "S256",
    });
    expect(firm.files.calls).toEqual([]);
  });

  test.failing("she follows the link and signs in, and the page she lands on shows one string to copy, with one button, loading nothing and sending nothing", async () => {
    const landed = await firm.signin.follow(link, "rosa");
    expect(landed.startsWith(firm.signin.page)).toBe(true);
    const page = await openPage(landed);
    expect(page.loads).toEqual([]);
    expect(page.buttons).toBe(1);
    string = page.string ?? "";
    expect(string).toMatch(new RegExp(`^${SIGNIN_STRING.source}$`));
    const [, state, code] = SIGNIN_STRING.exec(string) as RegExpExecArray;
    expect(state).toBe(stateOf(link) as string);
    expect(firm.signin.issued()).toContain(Buffer.from(code as string, "base64url").toString());
    expect(await page.press()).toEqual([string]);
    expect(page.shows).toMatch(/coworker/i);
  });

  test.failing("she sends the string at her desk: duck trades it at once with the link's verifier and the app's secret, keeps the sign-in where only duck reads it, her coworker reads that she connected the plug and is told how to see its tools, and the plug gets her token", async () => {
    firm.model.on(
      all(wren, said("Rosa Alvarez connected files"), said("files__connect")),
      call("files__connect"),
    );
    firm.model.on(all(wren, answered("files__connect")), call("files__list_files"));
    firm.model.on(all(wren, answered("list_files")), say("You have 4B lease.pdf and 4B renewal.docx."));
    await firm.person.send("desk", `Here it is: ${string}`);
    await firm.person.nextWith("4B lease.pdf", 60);

    expect(trades().map(({ ok, secret, redirect }) => ({ ok, secret, redirect }))).toEqual([
      { ok: true, secret: true, redirect: firm.signin.page },
    ]);
    const first = firm.model.requests.find(said("Rosa Alvarez connected files"));
    expect((trades()[0]?.at ?? Number.POSITIVE_INFINITY) < (first?.started ?? 0)).toBe(true);
    const grant = firm.signin.grantOf("rosa");
    expect(firm.files.callsTo("list_files").map((c) => c.headers.get("authorization"))).toEqual([
      `Bearer ${grant?.access}`,
    ]);
    expect(holding(grant?.refresh as string)).toEqual([`${harbor.coworker}/keys.env`]);
    await keptOnlyAsSignIns([string]);
  });

  test.failing("the same message delivered again changes nothing kept, and the string sent again in a new message does nothing but say so", async () => {
    const kept = firm.signin.grantOf("rosa");
    await firm.person.again();
    await firm.person.quiet(5);
    firm.model.on(all(wren, said("did nothing")), say("That code did nothing; you are connected already."));
    await firm.person.send("desk", `Again: ${string}`);
    await firm.person.nextWith("connected already", 60);

    expect(trades()).toEqual([]);
    expect(firm.signin.grantOf("rosa")).toEqual(kept);
    expect(holding(kept?.refresh as string)).toEqual([`${harbor.coworker}/keys.env`]);
    await keptOnlyAsSignIns([string]);
  });

  test.failing("once her token has run out, duck renews it once without her and the plug gets the new one", async () => {
    const ASK = "Any new files?";
    const before = firm.signin.grantOf("rosa");
    firm.signin.expire("rosa");
    firm.model.on(all(wren, said(ASK)), call("files__list_files"));
    firm.model.on(all(wren, answered("list_files")), say("Still 4B lease.pdf and 4B renewal.docx."));
    await firm.person.send("desk", ASK);
    await firm.person.nextWith("Still 4B lease.pdf", 60);

    expect(renewals().map(({ ok, secret }) => ({ ok, secret }))).toEqual([{ ok: true, secret: true }]);
    const now = firm.signin.grantOf("rosa");
    expect(now?.access).not.toBe(before?.access);
    expect(firm.files.callsTo("list_files").map((c) => c.headers.get("authorization"))).toEqual([
      `Bearer ${now?.access}`,
    ]);
    expect(holding(now?.refresh as string)).toEqual([`${harbor.coworker}/keys.env`]);
    expect(holding(before?.access as string)).toEqual([]);
    await keptOnlyAsSignIns([string]);
  });

  test.failing("a string made for another coworker does nothing at hers but say so, and still connects the coworker it was made for", async () => {
    const ASK = "Can you see my drive?";
    firm.model.on(all(finch, said(ASK)), call("files__connect"));
    firm.model.on(all(finch, answered("files__connect")), (r) => say(`Sign in here: ${linkIn(r.last)}`));
    await firm.second.send("desk", ASK);
    const theirs = linkIn((await firm.second.nextWith("Sign in here", 60)).text);
    const theo = (await openPage(await firm.signin.follow(theirs, "theo"))).string ?? "";

    firm.model.on(all(wren, said("did nothing")), say("That code is not one of mine."));
    await firm.person.send("desk", `Use this one: ${theo}`);
    await firm.person.nextWith("not one of mine", 60);
    expect(trades()).toEqual([]);
    expect(holding(firm.signin.grantOf("rosa")?.refresh as string)).toEqual([`${harbor.coworker}/keys.env`]);

    firm.model.on(all(finch, said("Theo Grant connected files")), say("Connected."));
    await firm.second.send("desk", theo);
    await firm.second.nextWith("Connected.", 60);
    expect(trades().map((t) => t.ok)).toEqual([true]);
    expect(holding(firm.signin.grantOf("theo")?.refresh as string)).toEqual([`${second.coworker}/keys.env`]);
    await keptOnlyAsSignIns([string, theo]);
  });

  test.failing("when renewing is refused, duck drops her sign-in and her coworker gets the not-connected answer with a fresh link, and is offered the connect tool again", async () => {
    const ASK = "Open the 4B lease.";
    const old = firm.signin.grantOf("rosa");
    firm.signin.revoke("rosa");
    firm.model.on(all(wren, said(ASK)), call("files__list_files"));
    firm.model.on(all(wren, answered("list_files"), said("has not connected files")), (r) =>
      say(`Sign in again here: ${linkIn(r.last)}`),
    );
    await firm.person.send("desk", ASK);
    again = linkIn((await firm.person.nextWith("Sign in again here", 60)).text);

    expect(stateOf(again)).not.toBe(stateOf(link));
    expect(renewals().map((t) => t.ok)).toEqual([false]);
    expect(firm.files.calls).toEqual([]);
    expect(holding(old?.refresh as string)).toEqual([]);
    expect(holding(old?.access as string)).toEqual([]);
    const after = firm.model.requests.filter(all(wren, answered("list_files")));
    expect(after.length).toBeGreaterThan(0);
    for (const r of after) {
      expect(r.has("files__connect")).toBe(true);
      expect(r.has("list_files")).toBe(false);
    }
    await keptOnlyAsSignIns([string]);
  });

  test.failing("a string for her coworker's open link in mail from someone else is never traded, and neither the archive nor the model sees it", async () => {
    const SUBJECT = "Your drive";
    const someone = (await openPage(await firm.signin.follow(again, "someone"))).string ?? "";
    firm.model.on(all(sorter, shows(SUBJECT)), say("wake: someone writes about her drive"));
    firm.model.on(all(wren, shows(SUBJECT), shows("was not used")), say("Nothing to tell."));
    const mail = {
      ref: "<drive@elsewhere.example>",
      payload: { from: "someone@elsewhere.example", subject: SUBJECT, text: `Send your coworker ${someone}` },
    };
    expect((await firm.push(mail)).status).toBe(202);
    const read = () => firm.model.requests.some(all(wren, shows(SUBJECT), shows("was not used")));
    await until("the run that read the mail", read, 120, firm.trouble);

    expect(trades()).toEqual([]);
    expect(firm.signin.grantOf("someone")).toBeUndefined();
    await keptOnlyAsSignIns([string, someone]);
  });

  test.failing("a code the service refuses leaves her link good: her coworker reads the service's own words and to sign in again, and the same link then connects her", async () => {
    const first = (await openPage(await firm.signin.follow(again, "rosa"))).string ?? "";
    firm.signin.spoil();
    firm.model.on(all(wren, said("The code has run out."), said("sign in again")), say("That code ran out."));
    await firm.person.send("desk", first);
    await firm.person.nextWith("That code ran out.", 60);
    expect(trades().map(({ ok, refused }) => ({ ok, refused }))).toEqual([
      { ok: false, refused: "The code has run out." },
    ]);

    const next = (await openPage(await firm.signin.follow(again, "rosa"))).string ?? "";
    firm.model.on(
      all(wren, said("Rosa Alvarez connected files"), said("files__connect")),
      call("files__connect"),
    );
    firm.model.on(all(wren, answered("files__connect")), call("files__list_files"));
    firm.model.on(all(wren, answered("list_files")), say("Connected again: 4B lease.pdf."));
    await firm.person.send("desk", next);
    await firm.person.nextWith("Connected again", 60);
    expect(trades().map((t) => t.ok)).toEqual([false, true]);
    const grant = firm.signin.grantOf("rosa");
    expect(firm.files.callsTo("list_files").map((c) => c.headers.get("authorization"))).toEqual([
      `Bearer ${grant?.access}`,
    ]);
    expect(holding(grant?.refresh as string)).toEqual([`${harbor.coworker}/keys.env`]);
    await keptOnlyAsSignIns([string, first, next]);
  });

  test.failing("duck check names what a plug's sign-in lacks", async () => {
    let whole: Record<string, unknown> = {};
    firm.edit((setup) => {
      const signin = setup.plugs.files?.signin as Record<string, unknown>;
      whole = { ...signin };
      delete signin.token;
      delete signin.page;
    });
    const printed = await firm.duck("check").then(
      (out) => out,
      (error: Error) => error.message,
    );
    firm.edit((setup) => {
      (setup.plugs.files as { signin?: Record<string, unknown> }).signin = whole;
    });
    expect(printed).toContain("plug files's signin names no token or page");
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  answered,
  type Buzz,
  both,
  call,
  E2E,
  type Firm,
  harbor,
  held,
  loadPlugin,
  type Speech,
  type SpeechSession,
  said,
  say,
  shows,
  startBuzz,
  startFirm,
  startSpeech,
  until,
} from "../kit";

/** How long a call lasts on the test's relay, in seconds, so a step reaches its end. */
const TTL = 120;
const [HELLO, HI] = ["Are you there?", "I'm here."];
const ASK = "Please find the 4B lease and tell me when it is due.";
const [FIRST, ANSWER] = ["I'll pull the 4B lease.", "The 4B lease is up for renewal on March 1."];
/** Her Preferences' cost line, and the admins' card's cost, once she has talked with her coworker this month. */
const PREFERENCES = /^Model use this month at list price: \$\d+\.\d\d and \d+ min of voice calls$/;
const CARD = /^\$\d+\.\d\d and \d+ min of voice calls$/;

setDefaultTimeout(E2E);

// The voice door's steps: a throwaway Buzz relay whose calls last TTL seconds, the person calling as Buzz's
// phone app does with tones for words, and a stand-in for the speech model at the address the door's setup
// names. One relay and one firm for every step, which run in order.
describe("a person talks with their coworker in a call", () => {
  let speech: Speech;
  let buzz: Buzz;
  let firm: Firm;
  let wren: string;
  /** Her DM with her coworker. */
  let dm: string;
  beforeAll(async () => {
    speech = startSpeech();
    buzz = await startBuzz({ ttl: TTL });
    firm = await startFirm({ buzz });
    wren = buzz.keys.wren;
    dm = await buzz.dmWith("rosa", wren);
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
    await buzz?.[Symbol.asyncDispose]();
    await speech?.[Symbol.asyncDispose]();
  }, E2E);
  afterEach(async () => {
    try {
      await firm.step();
    } finally {
      speech.step();
    }
  }, E2E);

  type Call = Awaited<ReturnType<Buzz["call"]>>;
  /** She calls her coworker in `parent` and it joins; returns the call and the door's session with the speech model. */
  async function open(parent: string, sessions = 1) {
    const call = await buzz.call("rosa", parent);
    await call.joins(wren, 30);
    return { call, session: await speech.opened(sessions) };
  }
  /** How many calls the voice door has logged leaving since the step began. */
  const lefts = async () => (await firm.logged("call")).filter((l) => l.happened === "left").length;
  /**
   * Waits until the voice door has logged leaving `count` calls since the step began, which it does once its
   * session with the speech model has closed and what it keeps of the call is kept.
   */
  async function doorLeft(count: number) {
    for (const end = Date.now() + 30_000; (await lefts()) < count; await Bun.sleep(200))
      if (Date.now() > end) throw new Error(`waited 30 s for the voice door to leave ${count} calls`);
  }
  /**
   * She hangs up, and waits until her coworker has closed its session with the speech model and its voice door
   * has left the call.
   */
  async function hangUp(call: Call, session: SpeechSession) {
    const before = await lefts();
    call.hangUp();
    await until("the session with the speech model closed", () => session.closed, 30, speech.trouble);
    await doorLeft(before + 1);
  }
  /** What the door gave the speech model to say. */
  const spoken = (session: SpeechSession) =>
    session.given.filter((g) => g.type === "commentary").map((g) => g.content);
  /** Waits until the door has given the speech model `text` to say. */
  const speaks = (session: SpeechSession, text: string, seconds = 60) =>
    until(`"${text}" given to the speech model`, () => spoken(session).includes(text), seconds, firm.trouble);
  /** The archive's messages at the voice door, after message `after`, in order. */
  const archived = (after = 0) => {
    using db = firm.db();
    return db
      .query<{ id: number; way: string; text: string }, [number]>(
        "select id, way, text from messages where door = 'voice' and id > ? order by id",
      )
      .all(after);
  };
  const lastMessage = () => {
    using db = firm.db();
    return db.query<{ id: number }, []>("select coalesce(max(id), 0) as id from messages").get()?.id ?? 0;
  };
  /** The states of the inbox events the voice door wrote, oldest first. */
  const voiceEvents = () => {
    using db = firm.db();
    return db
      .query<{ state: string }, []>("select state from inbox where source = 'voice' order by id")
      .all()
      .map((e) => e.state);
  };

  test("the admin gives her coworker a voice door: duck check names what it lacks, and once it names its speech model, voice and secret it installs", async () => {
    firm.edit((setup) => {
      (setup.doors[harbor.coworker] as Record<string, object>).voice = {
        kind: "voice",
        address: speech.door.address,
      };
    });
    const checked = await firm.duck("check").then(
      (out) => out,
      (error: Error) => error.message,
    );
    expect(checked).toContain(`door ${harbor.coworker}.voice names no model, voice or key`);

    firm.addSecret(speech.door.key, speech.secret);
    await firm.reinstall((setup) => {
      (setup.doors[harbor.coworker] as Record<string, object>).voice = speech.door;
    });
    expect(await firm.duck("check")).not.toContain(`${harbor.coworker}.voice`);
    await buzz.person.online(120);
  });

  test("after writing to it in Buzz, she calls her coworker in a private channel of just the two of them: it joins as itself, and its speech model is given its instructions and their names and nothing else", async () => {
    firm.model.on(said(HELLO), say(HI));
    await buzz.person.send(HELLO);
    expect((await buzz.person.next(60)).content).toBe(HI);

    const parent = await buzz.privateChannel("rosa", [wren]);
    const { call, session } = await open(parent);
    const joined = await buzz.query("rosa", [{ kinds: [48101], "#h": [parent] }]);
    expect(joined.some((e) => e.tags.some(([t, key]) => t === "p" && key === wren))).toBe(true);
    expect(session.start).toMatchObject({
      model: speech.door.model,
      audio: { output: { voice: speech.door.voice } },
    });
    const instructions = String(session.start.instructions);
    expect(instructions).toContain(harbor.name);
    expect(instructions).toMatch(new RegExp(`\\b${harbor.coworker}\\b`, "i"));
    for (const before of [HELLO, HI]) expect(instructions).not.toContain(before);
    await hangUp(call, session);
  });

  test("her spoken line is her message at the voice door, whole though its last word was heard after the hand-off: she hears the speech model's acknowledgement, then her coworker's first line and answer spoken", async () => {
    firm.model.on(said(ASK), both(say(FIRST), call("shell", { command: "true" })));
    firm.model.on(answered("shell"), say(ANSWER));
    const before = lastMessage();
    const { call: inCall, session } = await open(dm);
    const ended = await inCall.say(ASK);
    const acknowledged = await inCall.hears("acknowledgement", ended, 30);
    await speaks(session, ANSWER);
    const words = await inCall.hears("said", acknowledged, 30);
    console.log(
      `voice door: the acknowledgement was heard ${Math.round(acknowledged - ended)} ms and the coworker's first words ${Math.round(words - ended)} ms after her line ended`,
    );
    expect(spoken(session)).toEqual([FIRST, ANSWER]);
    expect(firm.model.requests.filter(said(ASK))).toHaveLength(1);
    expect(archived(before).filter((m) => m.way === "in")).toEqual([expect.objectContaining({ text: ASK })]);
    await hangUp(inCall, session);
  });

  test("she speaks while her coworker is working, and it steers that run instead of starting a second", async () => {
    const [PULL, ALSO] = ["Can you pull the 5C lease?", "And the gate code for 5C?"];
    const BOTH = "The 5C lease is pulled, and its gate code is 1357.";
    firm.model.on(said(PULL), both(say("Pulling the 5C lease."), call("shell", { command: "true" })));
    firm.model.on(answered("shell"), held("pulling", say("Pulled it.")));
    firm.model.on(shows(ALSO), say(BOTH));
    const { call: inCall, session } = await open(await buzz.privateChannel("rosa", [wren]));
    await inCall.say(PULL);
    await firm.model.reached("pulling");
    await inCall.say(ALSO);
    await until(
      "her second line handed to the run going",
      () => voiceEvents().slice(-2).join() === "running,running",
      30,
      firm.trouble,
    );
    firm.model.release("pulling");
    await speaks(session, BOTH);
    expect(firm.model.requests.findLast(shows(ALSO))?.shows(PULL)).toBe(true);
    await hangUp(inCall, session);
  });

  test("a line the speech model hands off with no transcript is not handed on, and the speech model is told to ask her to say it again", async () => {
    const MUMBLE = "Could you also look at the boiler in 2A";
    speech.hears(MUMBLE, { transcript: false });
    const events = voiceEvents().length;
    const { call: inCall, session } = await open(dm);
    await inCall.say(MUMBLE);
    await until(
      "the speech model told of that hand-off",
      () => session.given.some((g) => g.delegation === session.delegations[0]?.id),
      30,
      speech.trouble,
    );
    expect(voiceEvents()).toHaveLength(events);
    await hangUp(inCall, session);
  });

  test("she talks over an answer: it stops, and the archive keeps what was said, cut where she cut it", async () => {
    const [TELL, STOP] = ["Tell me everything about the 2A boiler.", "Wait, stop."];
    const LONG =
      "The 2A boiler was serviced in May, its pilot light failed twice in October, the part is on order from the supplier, and the plumber comes back on Friday morning to fit it and test the heat in every unit on that floor.";
    speech.hears(STOP, { hand: false });
    firm.model.on(said(TELL), say(LONG));
    const before = lastMessage();
    const { call: inCall, session } = await open(dm);
    const ended = await inCall.say(TELL);
    const started = await inCall.hears("said", ended, 60);
    await Bun.sleep(Math.max(0, started + 1000 - performance.now()));
    await inCall.say(STOP);
    await hangUp(inCall, session);
    const out = archived(before)
      .filter((m) => m.way === "out")
      .map((m) => m.text);
    const cut = out.find((t) => t.startsWith("The 2A boiler")) ?? "";
    expect(cut).toStartWith("The 2A boiler");
    expect(LONG.startsWith(cut)).toBe(true);
    expect(cut.length).toBeLessThan(LONG.length / 2);
    expect(out).not.toContain(LONG);
  });

  test("she hangs up while her coworker is still working: it leaves, its session with the speech model closes, the call ends, the archive keeps the call's start and end around what was said, and the answer reaches her in Buzz", async () => {
    const LATE = "What did the inspector say about 3D?";
    const LATER = "The inspector passed 3D with one note about the smoke alarm.";
    firm.model.on(said(LATE), both(say("I'll check the 3D report."), call("shell", { command: "true" })));
    firm.model.on(answered("shell"), held("report", say(LATER)));
    const before = lastMessage();
    const { call: inCall, session } = await open(dm);
    await inCall.say(LATE);
    await firm.model.reached("report");
    // The archive keeps what was said, so she hangs up once its first line has been said.
    await until(
      "its first line said in the call",
      () => session.spoken.includes("I'll check the 3D report."),
      60,
      speech.trouble,
    );
    await hangUp(inCall, session);
    // The relay ends a call (kind 48103) once nobody is left in it.
    const over = async () =>
      (await buzz.query("rosa", [{ kinds: [48103], "#h": [dm] }])).some((e) =>
        e.content.includes(inCall.backing),
      );
    for (const end = Date.now() + 30_000; !(await over()); await Bun.sleep(500))
      if (Date.now() > end) throw new Error("waited 30 s for the relay to end the call");

    firm.model.release("report");
    expect((await buzz.person.next(60)).content).toBe(LATER);
    expect(spoken(session)).not.toContain(LATER);
    const kept = archived(before);
    expect(kept[0]?.way).toBe("call");
    expect(kept.at(-1)?.way).toBe("call");
    expect(kept.filter((m) => m.way === "in").map((m) => m.text)).toEqual([LATE]);
    expect(kept.filter((m) => m.way === "out").map((m) => m.text)).toContain("I'll check the 3D report.");
  });

  test("her coworker leaves a call she ends in Buzz while still in it, and a call that nears its time limit before the limit", async () => {
    const ended = await open(await buzz.privateChannel("rosa", [wren]));
    await ended.call.end();
    await ended.call.leaves(wren, 30);
    await until("the first session closed", () => ended.session.closed, 30, speech.trouble);
    await doorLeft(1);
    ended.call.hangUp();

    const timed = await open(await buzz.privateChannel("rosa", [wren]), 2);
    const left = await timed.call.leaves(wren, TTL + 30);
    expect(left).toBeLessThan(timed.call.ends);
    expect(left).toBeGreaterThan(timed.call.ends - 60_000);
    expect(timed.session.closed).toBe(true);
    await doorLeft(2);
    timed.call.hangUp();
  });

  test("a call her coworker's person did not start, one with a third member, and one while another is open are not joined", async () => {
    const open1 = await open(dm);
    const others = [
      ["theo", await buzz.call("theo", await buzz.dmWith("theo", wren))],
      ["rosa", await buzz.call("rosa", buzz.channel)],
      ["rosa", await buzz.call("rosa", await buzz.privateChannel("rosa", [buzz.keys.theo, wren]))],
      ["rosa", await buzz.call("rosa", await buzz.privateChannel("rosa", [wren]))],
    ] as const;
    await Bun.sleep(15_000);
    for (const [who, other] of others) {
      expect(other.inCall()).not.toContain(wren);
      const joined = await buzz.query(who, [{ kinds: [48101], "#h": [other.parent] }]);
      expect(joined.some((e) => e.tags.some(([t, key]) => t === "p" && key === wren))).toBe(false);
      other.hangUp();
    }
    expect(speech.sessions).toHaveLength(1);
    await hangUp(open1.call, open1.session);
  });

  test("a call is one line in duck's cost log with the seconds the speech model reported, and the month's voice minutes show beside the model cost in her Preferences and on the admins' card", async () => {
    const LINE = "Just checking the line works.";
    speech.hears(LINE, { hand: false });
    const { call: inCall, session } = await open(dm);
    await inCall.say(LINE);
    await hangUp(inCall, session);
    const voice = (await firm.logged("relay")).filter((l) => l.kind === "voice");
    expect(voice).toHaveLength(1);
    expect(voice[0]).toMatchObject({
      relay: harbor.coworker,
      kind: "voice",
      model: speech.door.model,
      seconds: session.seconds,
    });
    expect(voice[0]?.cost ?? null).toBeNull();

    const plugin = await loadPlugin(buzz, "rosa");
    const preferences = await plugin.tab("Preferences", wren, (l) => l.some((t) => PREFERENCES.test(t)));
    expect(preferences.lines).toContainEqual(expect.stringMatching(PREFERENCES));
    const card = await plugin.card("Coworkers", (l) => l.some((t) => CARD.test(t)));
    expect(card.lines).toContainEqual(expect.stringMatching(CARD));
  });

  test.failing("the speech model ends its session first: her coworker leaves the call, and joins the next call she starts", async () => {
    const first = await open(dm);
    speech.ends(first.session);
    await first.call.leaves(wren, 30);
    await doorLeft(1);
    first.call.hangUp();
    const next = await open(dm, 2);
    await hangUp(next.call, next.session);
  });
});

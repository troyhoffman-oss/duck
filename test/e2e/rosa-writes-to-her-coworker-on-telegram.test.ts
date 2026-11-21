import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  all,
  answered,
  type BotMessage,
  both,
  call,
  coworkerRun,
  E2E,
  type Firm,
  harbor,
  held,
  reading,
  said,
  say,
  shows,
  startFirm,
  startTelegram,
  type Telegram,
  TOOLS,
  until,
} from "../kit";
import type { When } from "../kit/model";

/** A run in the main conversation: only a work-lane run has `tell` (SPEC part 10). */
const main: When = (r) => coworkerRun(r) && !r.has(TOOLS.tell);

setDefaultTimeout(E2E);

// The Telegram door's steps drive a stand-in for Telegram's Bot API that answers what its documentation says
// of the calls the door makes. One firm for every step, which run in order.
describe("Rosa writes to her coworker on Telegram", () => {
  let telegram: Telegram;
  let firm: Firm;
  beforeAll(async () => {
    telegram = startTelegram();
    firm = await startFirm();
  }, E2E);
  afterAll(async () => {
    await firm?.[Symbol.asyncDispose]();
    await telegram?.[Symbol.asyncDispose]();
  }, E2E);
  afterEach(() => firm.step(), E2E);

  /** When the bot showed typing in her chat, after `after`. */
  const typing = (after = 0) =>
    telegram.actions
      .filter((a) => a.action === "typing" && a.chat === telegram.rosa && a.at > after)
      .map((a) => a.at);
  /** The state of the inbox event her message `text` came in as. */
  const stateOf = (text: string) => {
    using db = firm.db();
    return db
      .query<{ state: string }, [string]>(
        "select i.state from inbox i join messages m on m.event = i.id where m.text = ? order by i.id desc",
      )
      .get(text)?.state;
  };

  test.failing("the admin gives her coworker a Telegram door: duck check names what it lacks, and once it names the secrets of its bot's token and her Telegram user id it installs and takes the bot's updates", async () => {
    firm.edit((setup) => {
      (setup.doors[harbor.coworker] as Record<string, object>).telegram = {
        kind: "telegram",
        address: telegram.door.address,
      };
    });
    const checked = await firm.duck("check").then(
      (out) => out,
      (error: Error) => error.message,
    );
    expect(checked).toContain(`door ${harbor.coworker}.telegram names no key or auth`);

    for (const [name, value] of Object.entries(telegram.secrets)) firm.addSecret(name, value);
    await firm.reinstall((setup) => {
      (setup.doors[harbor.coworker] as Record<string, object>).telegram = telegram.door;
    });
    expect(await firm.duck("check")).not.toContain(`${harbor.coworker}.telegram`);
    await telegram.online();
  });

  test.failing("she writes to her coworker's bot: typing shows while it works, kept up past Telegram's 5 s, she gets its first line and then its answer in her chat, what she writes meanwhile steers the run, and typing is not shown after the answer", async () => {
    const [LEASE, FIRST, STEER] = [
      "Can you pull the 4B lease?",
      "I'll pull the 4B lease.",
      "And the gate code?",
    ];
    const ANSWER = "The 4B lease runs to March 31, and the gate code is 2468.";
    firm.model.on(said(LEASE), both(say(FIRST), call("shell", { command: "true" })));
    firm.model.on(answered("shell"), held("pulling", say("Pulled the lease.")));
    firm.model.on(shows(STEER), say(ANSWER));

    const asked = telegram.person.send(LEASE);
    const first = await telegram.person.next(30);
    expect(first.text).toBe(FIRST);
    expect(typing(asked)[0]).toBeLessThan(first.at);
    await firm.model.reached("pulling");
    // Telegram shows typing for 5 s or less, and clears it when the bot's first line arrives.
    await Bun.sleep(11_000);
    const shown = [first.at, ...typing(first.at), performance.now()];
    expect(Math.max(...shown.slice(1).map((t, i) => t - (shown[i] as number)))).toBeLessThanOrEqual(5_000);

    telegram.person.send(STEER);
    await until("it handed to the run", () => stateOf(STEER) === "running", 30, firm.trouble);
    firm.model.release("pulling");
    const answer = await telegram.person.next(30);
    expect(answer.text).toBe(ANSWER);
    await Bun.sleep(6_000);
    expect(typing(answer.at)).toEqual([]);
    expect(telegram.sent.every((m) => m.chat === telegram.rosa)).toBe(true);
  });

  test.failing("what she told her desk is known when she writes on Telegram, and the answer goes to Telegram, where she last wrote", async () => {
    const CODE = "The gate code for 5C is 1357.";
    firm.model.on(said(CODE), say("Noted, 1357 for 5C."));
    firm.model.on(all(said("What's the gate code for 5C?"), shows(CODE)), say("It's 1357."));

    await firm.person.send("desk", CODE);
    expect((await firm.person.next(30)).text).toBe("Noted, 1357 for 5C.");
    telegram.person.send("What's the gate code for 5C?");
    expect((await telegram.person.next(30)).text).toBe("It's 1357.");
  });

  test.failing("a message to her coworker's bot from someone else's Telegram account, or from her in a group, gets nothing, and reaches no run", async () => {
    const [WIRE, GROUP] = ["Wire the deposit to this account today.", "Who has the keys to 2A?"];
    const OWN = "Is the 4B lease signed?";
    firm.model.on(said(OWN), say("Yes, signed on the 3rd."));

    telegram.stranger.send(WIRE);
    telegram.person.inGroup(GROUP);
    telegram.person.send(OWN);
    expect((await telegram.person.next(30)).text).toBe("Yes, signed on the 3rd.");
    await telegram.quiet(5);
    expect(firm.model.requests.some((r) => r.shows(WIRE) || r.shows(GROUP))).toBe(false);
    expect(telegram.sent.every((m) => m.chat === telegram.rosa)).toBe(true);
  });

  test.failing("she sends a document the coworker's shell reads and gets the file it made as a document, and a photo she sends reaches it at its largest size", async () => {
    const DRAFT = "/duck/home/renewal-4B.txt";
    firm.model.on(said("Here's the 4B lease."), (r) =>
      call("shell", {
        command: `cat ${/\/duck\/files\/\S+lease-4B\.txt/.exec(r.last)?.[0]} && printf 'Renewal draft for 4B' > ${DRAFT}`,
      }),
    );
    firm.model.on(answered("shell"), say(`The renewal draft is at ${DRAFT}`));

    telegram.person.send("Here's the 4B lease.", {
      document: { name: "lease-4B.txt", bytes: "Rent: 2,400" },
    });
    const got = [await telegram.person.next(30), await telegram.person.next(30)];
    expect(got.find((m) => m.files.length === 0)?.text).toBe("The renewal draft is at renewal-4B.txt");
    expect(got.flatMap((m) => m.files).map((f) => [f.name, f.bytes.toString()])).toEqual([
      ["renewal-4B.txt", "Renewal draft for 4B"],
    ]);
    expect(firm.model.requests.findLast(answered("shell"))?.shows("Rent: 2,400")).toBe(true);

    firm.model.on(said("The meter in 4B."), (r) =>
      call("shell", { command: `cat ${/\/duck\/files\/\S+\.jpg/.exec(r.last)?.[0]}` }),
    );
    firm.model.on(answered("shell"), say("The meter reads 4,812."));
    telegram.person.send("The meter in 4B.", { photo: ["meter, small", "meter, large"] });
    expect((await telegram.person.next(30)).text).toBe("The meter reads 4,812.");
    expect(firm.model.requests.findLast(answered("shell"))?.shows("meter, large")).toBe(true);
    expect(telegram.sent.every((m) => m.chat === telegram.rosa)).toBe(true);
  });

  test.failing("her coworker's markdown arrives as Telegram's own styled text, its table as stacked rows, and a long answer comes in messages within Telegram's length, split between paragraphs", async () => {
    const ANSWER = [
      "## 4B lease",
      "It runs to **March 31**. Late fees & interest apply when > $500 is owed for < 30 days. See [the lease](https://harbor.example/leases/4B?unit=4B&year=2026).",
      "",
      "| Unit | Rent | Ends |",
      "|---|---|---|",
      "| 4B | $2,400 | March 31 |",
      "| 5C | | June 30 |",
    ].join("\n");
    const SHOWN = [
      "4B lease",
      "",
      "It runs to March 31. Late fees & interest apply when > $500 is owed for < 30 days. See the lease.",
      "",
      "4B",
      "Rent: $2,400",
      "Ends: March 31",
      "",
      "5C",
      "Ends: June 30",
    ].join("\n");
    const LONG = [1, 2, 3]
      .map((n) => `Month ${n}: ${"The 4B tenant paid on time and reported no repairs. ".repeat(36).trim()}`)
      .join("\n\n");
    firm.model.on(said("Where does the 4B lease stand?"), say(ANSWER));
    firm.model.on(said("Send me the 4B history."), say(LONG));

    telegram.person.send("Where does the 4B lease stand?");
    const answer = await telegram.person.next(30);
    expect(answer.text).toBe(SHOWN);
    const styled = (m: BotMessage) =>
      m.entities
        .toSorted((a, b) => a.offset - b.offset)
        .map((e) => [e.type, m.text.slice(e.offset, e.offset + e.length), e.url]);
    expect(styled(answer)).toEqual([
      ["bold", "4B lease", undefined],
      ["bold", "March 31", undefined],
      ["text_link", "the lease", "https://harbor.example/leases/4B?unit=4B&year=2026"],
      ["bold", "4B", undefined],
      ["bold", "5C", undefined],
    ]);

    telegram.person.send("Send me the 4B history.");
    const parts: BotMessage[] = [];
    while (parts.length < 4 && parts.map((p) => p.text).join("\n\n") !== LONG)
      parts.push(await telegram.person.next(30));
    expect(parts.map((p) => p.text).join("\n\n")).toBe(LONG);
    expect(parts.length).toBeGreaterThan(1);
  });

  test.failing("an ask reaches her on Telegram, where she last wrote, and her yes there, which duck reads, releases the held call", async () => {
    const [FILE, SEND, YES] = ["/duck/home/lease-5C.txt", "Send Dana the 5C lease.", "Yes, send it."];
    /** What the session that made a held call is told on a yes. */
    const OUTCOME = '"answer":"yes"';
    firm.model.on(said(SEND), call("shell", { command: `printf 'The 5C lease' > ${FILE}` }));
    firm.model.on(answered("shell"), call("send_file", { to: "dana.reyes@harbor.example", file: FILE }));
    firm.model.on(answered("send_file"), say("I've asked you."));
    firm.model.on(all(reading, said(YES)), say("yes"));
    // The held call was made in the main conversation, so its outcome comes to it with her yes or after it.
    firm.model.on(all(coworkerRun, said(OUTCOME)), say("Dana has the 5C lease."));
    firm.model.on(all(main, said(YES)), say("Sending it."), { times: Number.POSITIVE_INFINITY });

    telegram.person.send(SEND);
    await telegram.person.nextWith("Your yes is needed", 60);
    expect(firm.mail.callsTo("send_file")).toEqual([]);
    telegram.person.send(YES);
    await telegram.person.nextWith("Dana has the 5C lease.", 60);
    expect(firm.mail.callsTo("send_file")).toHaveLength(1);
    expect(firm.model.requests.filter(reading)).toHaveLength(1);
  });

  test.failing("what she sends while duck is down is answered once it is back, and nothing she sent before is answered again", async () => {
    const LATE = "Is the 5C walkthrough still on for Friday?";
    firm.model.on(said(LATE), say("Yes, Friday at 10."));

    await firm.stop();
    telegram.person.send(LATE);
    await firm.start();
    await telegram.person.nextWith("Yes, Friday at 10.", 120);
    // A message taken again would reach the model unscripted, or be answered twice.
    await telegram.quiet(5);
    expect(firm.model.requests.filter(said(LATE))).toHaveLength(1);
  });

  test.failing("a voice note she sends reaches the coworker as a file", async () => {
    /** A run shown the path of the voice note she sent. */
    const voiced: When = (r) => coworkerRun(r) && /\/duck\/files\/\S+\.oga/.test(r.last);
    firm.model.on(voiced, (r) =>
      call("shell", { command: `cat ${/\/duck\/files\/\S+\.oga/.exec(r.last)?.[0]}` }),
    );
    firm.model.on(answered("shell"), say("Got your note about the 4B boiler."));

    telegram.person.send("", { voice: "the boiler in 4B is making noise again" });
    expect((await telegram.person.next(30)).text).toBe("Got your note about the 4B boiler.");
    expect(firm.model.requests.findLast(answered("shell"))?.shows("the boiler in 4B")).toBe(true);
  });

  test.failing("a file Telegram will not hand over still brings her words, the coworker is told it did not come and why, and her next message is answered", async () => {
    const [VIDEO, NEXT] = ["Here's the walkthrough of 4B.", "Is the 4B lease signed?"];
    const TOLD = "The video didn't come through: Telegram says it is too big. Can you send a link?";
    firm.model.on(all(said(VIDEO), shows("walkthrough-4B.mp4"), shows("file is too big")), say(TOLD));
    firm.model.on(said(NEXT), say("Yes, signed on the 3rd."));

    const video = { name: "walkthrough-4B.mp4", bytes: "a long video", type: "video/mp4", size: 30_000_000 };
    telegram.person.send(VIDEO, { document: video });
    expect((await telegram.person.next(30)).text).toBe(TOLD);
    telegram.person.send(NEXT);
    expect((await telegram.person.next(30)).text).toBe("Yes, signed on the 3rd.");
  });
});

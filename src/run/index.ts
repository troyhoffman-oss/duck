import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { called, callStatus, cutShort, lastShown, lastTold, runEnded, runStarted, said } from "../archive";
import { answerOthers, deliver, listen } from "../doors";
import { JOB, lapse, OTHERS, WORK } from "../gate";
import {
  aboutSession,
  add,
  attach,
  type Event,
  itemSession,
  lastSession,
  mark,
  openDb,
  othersIn,
  waiting,
} from "../inbox";
import { AT_ONCE, checkerText, ended, endRef, type Job, moved, resume, take, workerText } from "../jobs";
import { gained, openItems, useList } from "../list";
import { history, memory, upTo } from "../notes";
import { due, openAsks, type Row, settle, tells } from "../outbox";
import { container, doorsOf, duckAddress, HOME, jobCalls, ms, personOf, type Setup } from "../setup";
import { GOOSE_PORT } from "../setup/install";
import { line, logLine, screen } from "../sorter";
import { dreaming, tick } from "../timers";
import { type Call, connect, type Update } from "./goose";

type Turn = {
  run: number;
  events: number[];
  /** Each steer's events, and its message's id where goose took it. */
  steers: Promise<{ ids: number[]; id?: string }>[];
  /** The ids of the messages goose added to the run, steers among them. */
  applied: Set<string>;
  started: number;
  lined: boolean;
  rows: number[];
};

/** Where a session works, and the gate's address for its lane, as goose takes them. */
type At = { cwd: string; mcpServers: object[] };

export type Coworker = ReturnType<typeof startCoworker>;

const NOTHING = Bun.hash("");

/**
 * Coworker `name`'s lanes in one goose, on its database: the person lane, its runs in the main conversation
 * and that conversation's compaction; the others lane, which answers others who mention it at a door that
 * answers them; the work lane, which runs everything else; and the job lanes, which run its jobs. Each lane
 * takes only its own events from the inbox, so one wake wakes them all. It listens at its doors, and `stop`
 * ends all of it.
 */
export function startCoworker(setup: Setup, name: string) {
  const own = join(setup.storage.folder, name);
  const db = openDb(join(own, "duck.db"));
  const stopping = new AbortController();
  const { signal } = stopping;
  const doors = Object.keys(doorsOf(setup, name));
  /** The sources of what others write at the doors that answer them, and with the doors, all the doors take. */
  const asked = Object.entries(doorsOf(setup, name))
    .filter(([, d]) => d.answers)
    .map(([door]) => `${door}:others`);
  const atDoors = [...doors, ...asked];
  const person = personOf(setup, name);
  // The gate is goose's one MCP server, named so goose offers its tools as duck__<tool>. goose keeps each
  // session's servers to that session, so the address a session is given lists its own lane's tools.
  const gateAt = (path: string) => [
    { type: "http", name: "duck", url: `${duckAddress(setup)}${path}`, headers: [] },
  ];
  // goose reads hint and skill files in a session's working folder (crates/goose/src/hints/load_hints.rs:270
  // and skills/mod.rs:321 at 1.59.0), so an others session works in an empty one of its own, not the home.
  const othersAt: At = { cwd: "/duck/goose/others", mcpServers: gateAt(OTHERS) };
  mkdirSync(join(own, "goose", "others"), { recursive: true });
  const [mcpServers, jobServers] = [gateAt("/mcp"), gateAt(JOB)];
  const workAt: At = { cwd: HOME, mcpServers: gateAt(WORK) };
  const idle = ms(setup.compaction.idle);
  let session = lastSession(db, doors);
  let runId: string | null = null;
  let turn: Turn | null = null;
  let message: { id?: string; text: string } | null = null;
  let compacting: number | null = null;
  let loading = false;
  /** Whether the person lane ran since it last rested. */
  let ran = false;
  /** Settles when the person lane next rests. */
  let rested = Promise.withResolvers<void>();
  let timer: Timer | undefined;
  /** The run each session other than the main conversation is in, while it runs. */
  const running = new Map<string, number>();
  let later: Timer | undefined;
  let gapping: Timer | undefined;
  const gap = ms(setup.sorter.gap);
  /** When its person last paused it, and once they resumed it, when: kept until its catch-up is worked. */
  let pause: { from: string; to?: string } | undefined;
  /**
   * Whether its person has paused it, read from its settings at each look, so a pause or resume holds from the
   * next one. The first look after a resume starts the catch-up.
   */
  function paused() {
    const from = person.paused ?? null;
    if (from) pause = { from };
    else if (pause) pause.to ??= new Date().toISOString();
    return from !== null;
  }
  /**
   * Whether it holds what would reach its person, but for their own runs and an urgent ask: while paused, and
   * until its catch-up is worked, so that its person hears of the catch-up once.
   */
  function holding() {
    paused();
    return pause !== undefined;
  }
  /** The outbox rows that may go now. */
  const dueNow = () => due(db, person, Date.now(), holding());

  const [home, files, sending] = [join(own, "home"), join(own, "files"), Promise.resolve()];
  resume(db);
  const keep = history(join(own, "history"), home);
  const memories = [
    `${person.name}'s standing words, from standing.md`,
    "the first line of each file in notes/",
    "the open items on your list",
    `what ${person.name} was asked and has not answered; their plain reply may answer one`,
  ];
  // What each session was last shown of those, as hashes. After a restart a session is shown all of them again.
  const seen = new Map<string, (number | bigint)[]>();

  /**
   * Ends the coworker's message. The person hears its first line, written before more work, at once, and the
   * answer the run ends on; what it writes between later steps is not for them. The outbox rows the run was
   * handed go with the first message it delivers.
   */
  function flush(answer = false) {
    const text = message?.text.trim();
    message = null;
    if (!text || !turn || !session) return;
    if (answer || !turn.lined) settle(db, turn.rows.splice(0), deliver(coworker, text, turn.started));
    turn.lined = true;
  }

  function update(id: string, u: Update) {
    const meta = u._meta?.goose;
    const main = id === session;
    if (main && meta && "activeRunId" in meta) runId = meta.activeRunId ?? null;
    // A session's replay on load, and goose's own words around a compaction, are not for the person, and
    // nothing the work lane writes is. The main conversation loads while a run may already wait for goose.
    const run = loading ? undefined : main ? turn?.run : running.get(id);
    if (run === undefined) return;
    if (main && u.sessionUpdate === "agent_message_chunk" && meta?.inference && u.content?.type === "text") {
      if (message?.id !== u.messageId) flush();
      message ??= { id: u.messageId, text: "" };
      message.text += u.content.text ?? "";
    } else if (u.sessionUpdate === "tool_call" && u.toolCallId) {
      if (main) flush();
      // goose names a call it could not read only by its title. A call to the gate's tools the gate keeps
      // itself, under an id of its own, before it reaches a plug, since goose may send this notice after the
      // call (crates/goose-agent/src/operation.rs:277 and crates/goose/src/agents/state_machine/
      // ops_toolcalling.rs:1094 at 1.59.0); goose's status for it then matches no row.
      const tool = meta?.toolCall?.toolName ?? u.title ?? "";
      if (!tool.startsWith("duck__")) called(db, id, u.toolCallId, tool, u.rawInput);
    } else if (u.sessionUpdate === "tool_call_update" && u.toolCallId && u.status)
      callStatus(db, u.toolCallId, u.status);
    else if (main && u.sessionUpdate === "user_message_chunk") {
      flush();
      if (u.messageId) turn?.applied.add(u.messageId);
    }
  }

  /**
   * Takes each of goose's extensions that `drop` names out of session `sessionId`, with goose's ACP methods
   * (crates/goose/acp-meta.json at 1.59.0).
   */
  async function strip(call: Call, sessionId: string, drop: (key: string) => boolean) {
    const { extensions } = await call("_goose/unstable/session/extensions/list", { sessionId });
    for (const { extensionKey } of extensions as { extensionKey: string }[])
      if (drop(extensionKey))
        await call("_goose/unstable/session/extensions/remove", { sessionId, extensionKey });
  }
  // A session keeps the extensions it was made with (crates/goose/src/agents/extension_manager/mod.rs:1168 at
  // 1.59.0), so one made before goose's config turned these off has them taken out when it is loaded.
  const off = (key: string) => ["summon", "extensionmanager"].includes(key);

  // goose that comes back has its sessions on disk, the main conversation among them. A run goose lost may not
  // have kept what it was shown, so each session is shown all of it again, as after a restart of duck.
  const goose = connect(
    `ws://${container(setup.firm, name)}:${GOOSE_PORT}/acp`,
    update,
    async (call) => {
      seen.clear();
      runId = null;
      loading = true;
      try {
        if (session) {
          await call("session/load", { sessionId: session, cwd: HOME, mcpServers });
          await strip(call, session, off);
        }
      } finally {
        loading = false;
      }
      wake();
    },
    signal,
  );
  const prompt = (text: string, sessionId = session) =>
    goose.call("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  /** The main conversation's session, once it has one. */
  const conversation = () => session;
  const { connected, up } = goose;
  /** The session each job at work is in, by the job's id. */
  const workers = new Map<number, string>();
  /** Cuts off the worker or checker of job `job`, which was stopped. */
  const cut = (job: number) => goose.notify("session/cancel", { sessionId: workers.get(job) });
  /** Each job run's model calls and cost so far, by the model relay's figure, by its session. */
  const spending = new Map<string, { who: string; calls: number; cost: number; cut?: string }>();
  /**
   * Counts a model call of session `s` that cost `cost`. A job's run that reaches the firm's most model calls
   * is cut off once, and keeps the words that say so (SPEC part 6).
   */
  const spent = (s: string, cost: number) => {
    const run = spending.get(s);
    if (!run || run.cut) return;
    run.calls++;
    run.cost += cost;
    const calls = jobCalls(setup);
    if (calls === undefined || run.calls < calls) return;
    run.cut = `The ${run.who} was cut at its cap of ${calls} model calls, after ${run.calls} model call${run.calls === 1 ? "" : "s"} costing $${run.cost.toFixed(2)}. The job's work so far is unverified.`;
    goose.notify("session/cancel", { sessionId: s });
  };
  const coworker = {
    name,
    setup,
    db,
    doors,
    files,
    home,
    sending,
    wake,
    conversation,
    connected,
    up,
    cut,
    workers,
    spent,
    signal,
    stop,
  };

  /**
   * Marks `events` running in session `s`, and returns the run's id and its prompt: what every run loads,
   * slowest-changing first (SPEC part 5), then `words`. The standing words, the notes' lines and the list
   * are shown where they changed since `s` last saw them, since a session's history holds what it saw, and so
   * are the lines the open items' logs gained since its last run began. Only a work-lane run is shown the last
   * messages sent, since the main conversation's own history holds them. A run that is not `mine`, an others
   * run, is shown none of the person's own (SPEC part 11).
   */
  function begin(s: string, events: Event[], words: string, mine = true) {
    const ids = events.map((e) => e.id);
    const cut = events.some((e) => e.state === "running") ? cutShort(db, s) : null;
    mark(db, ids, "running", s);
    const unknown = cut?.length
      ? ` These tool calls have no known result: ${cut.join("; ")}. Check before repeating one.`
      : "";
    const note = cut ? `Note from duck: your last run was cut short by a restart.${unknown}\n\n` : "";
    const sent = s === session || !mine ? [] : lastTold(db);
    const told =
      sent.length > 0
        ? `Note from duck: the last messages you sent ${person.name}, oldest first.\n${sent.join("\n")}\n\n`
        : "";
    const shown = mine
      ? [...memory(setup, home), openItems(db).join("\n"), s === session ? openAsks(db).join("\n") : ""]
      : [];
    const [last, now] = [seen.get(s), shown.map((t) => Bun.hash(t))];
    seen.set(s, now);
    const changed = shown.map((t, i) =>
      now[i] === (last?.[i] ?? NOTHING)
        ? ""
        : `Note from duck: ${memories[i]}${t ? `.\n${t}` : ": none."}\n\n`,
    );
    // An event the run is handed is shown it already, so its line on an item's log is not shown twice. A line
    // is cut short here, not on the log, and past the cap the newest are kept.
    const since = mine ? lastShown(db, s) : undefined;
    const lines = (since ? gained(db, since) : [])
      .filter((l) => !events.some((e) => l.endsWith(`, code: ${logLine(e)}`)))
      .map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
    const logs =
      lines.length > 0
        ? `Note from duck: what the logs of the open items on your list gained since this conversation was last shown them, oldest first.\n${upTo(lines, setup.notes?.log ?? 8000, true)}\n\n`
        : "";
    return { run: runStarted(db, s, ids), text: changed.join("") + logs + told + note + words };
  }

  /** What came in with `events`: each event from outside the doors as its source gave it, then what the person wrote. */
  function cameIn(events: Event[]) {
    const other = events.filter((e) => !doors.includes(e.source));
    const label = (e: Event) =>
      setup.sorter.mode === "on" && e.answer ? ` (the sorter: ${e.answer}, ${e.why})` : "";
    const lines = other.map((e) => line(e) + label(e));
    const note = other.length > 0 ? `Note from duck: what came in.\n${lines.join("\n")}\n\n` : "";
    const ids = events.map((e) => e.id);
    return note + said(db, ids);
  }

  /**
   * A lane: a wake while it rests runs `first` if given, then what `next` hands it, one run at a time, until it
   * hands nothing or the coworker stops, and then `rest`. A run that throws is logged, and its events wait for
   * the next wake, as a run a restart cut does. `going` settles when the lane rests.
   */
  function lane(what: string, next: () => (() => Promise<unknown>) | undefined, rest = () => {}) {
    let busy: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    const go = async (first?: () => Promise<unknown>) => {
      if (busy || signal.aborted) return;
      busy = Promise.withResolvers();
      try {
        for (let run = first ?? next(); run && !signal.aborted; run = next()) await run();
      } catch (error) {
        console.error(`${name}'s ${what} stopped a run: ${(error as Error).message}`);
      } finally {
        busy?.resolve();
        busy = undefined;
        if (!signal.aborted) rest();
      }
    };
    return Object.assign(go, { busy: () => busy !== undefined, going: () => busy?.promise });
  }

  /** Prompts session `s` with `text` as run `run`, whose updates are kept while it runs. */
  async function within(s: string, run: number, text: string) {
    running.set(s, run);
    try {
      return await prompt(text, s);
    } finally {
      running.delete(s);
    }
  }

  async function run(events: Event[], rows: Row[]) {
    session ??= (await goose.call("session/new", { cwd: HOME, mcpServers })).sessionId as string;
    const ids = events.map((e) => e.id);
    const held = paused()
      ? `Note from duck: ${person.name} has paused you, so you do no work on your own, and a job you start waits until they resume you.\n\n`
      : "";
    const begun = begin(session, events, held + tells(db, rows, person.name) + cameIn(events));
    const t: Turn = {
      run: begun.run,
      events: ids,
      steers: [],
      applied: new Set(),
      started: performance.now(),
      lined: false,
      rows: rows.map((r) => r.id),
    };
    turn = t;
    try {
      const { stopReason } = await prompt(begun.text);
      flush(true);
      // A steer is the run's only once goose added it, which it streams before the run's end. goose refuses one
      // that comes after the run, and drops one it took but had not added when the run ended
      // (crates/goose/src/acp/server.rs:1885 at 1.59.0); either waits for the next run.
      const dropped: number[] = [];
      for (const { ids, id } of await Promise.all(t.steers))
        (id && t.applied.has(id) ? t.events : dropped).push(...ids);
      mark(db, dropped, "pending");
      settle(db, t.rows, null);
      mark(db, t.events, "done");
      runEnded(db, t.run, t.events, stopReason);
      keep(t.run);
    } finally {
      [turn, message] = [null, null];
    }
    ran = true;
    // An ask the run raised goes once it ends, so the person's reply starts a run of its own.
    dispatch();
  }

  /** Hands what the person wrote during their own run to that run. */
  function steer() {
    const t = turn;
    const events = waiting(db, doors, session).filter((e) => e.state === "pending");
    if (!t || !runId || events.length === 0) return;
    const ids = events.map((e) => e.id);
    mark(db, ids, "running", session);
    const steered = goose.call("_goose/unstable/session/steer", {
      sessionId: session,
      expectedRunId: runId,
      prompt: [{ type: "text", text: cameIn(events) }],
    });
    t.steers.push(steered.catch(() => ({})).then((r) => ({ ids, id: r.messageId })));
  }

  /**
   * The person lane: the main conversation's events and the tell rows that may go, until none is left, and
   * the main conversation's compaction once it has been idle. While it holds, only its person's own message
   * starts a run; what else came in for the main conversation goes with the catch-up's tells.
   */
  const personLane = lane(
    "person lane",
    () => {
      const events = waiting(db, doors, session);
      if (holding() && !events.some((e) => doors.includes(e.source))) return;
      const rows = dueNow().rows.filter((r) => r.kind === "tell");
      if (events.length + rows.length > 0) return () => run(events, rows);
    },
    () => {
      rested.resolve();
      rested = Promise.withResolvers();
      if (ran) timer = setTimeout(() => personLane(compact), idle);
      ran = false;
      dispatch();
    },
  );

  /**
   * Runs `batch` in session `s`, or in a new one, at `at`, with `words`: a run of the work lane or the others
   * lane. A new session for a run that is not `mine`, an others run, keeps only the gate of goose's
   * extensions. `then` is given the session and the run once it ends, before its events are done.
   */
  async function runIn(
    s: string | undefined,
    batch: Event[],
    at: At,
    words: string,
    mine: boolean,
    then: (s: string, run: number) => unknown,
  ) {
    const id = s ?? ((await goose.call("session/new", at)).sessionId as string);
    if (s) {
      await goose.call("session/load", { sessionId: s, ...at });
      await strip(goose.call, s, off);
    }
    // goose starts its own extensions, its shell and file tools among them, in every session.
    else if (!mine) await strip(goose.call, id, (key) => key !== "duck");
    const begun = begin(id, batch, words, mine);
    const { stopReason } = await within(id, begun.run, begun.text);
    await then(id, begun.run);
    const ids = batch.map((e) => e.id);
    mark(db, ids, "done");
    runEnded(db, begun.run, ids, stopReason);
    dispatch();
  }

  // A plug's event, someone else's words at a door, or a part of duck that broke. Job ends, timers, asks'
  // outcomes, replies to what the coworker wrote in Buzz and what broke skip the sorter.
  const outside = (e: Event) =>
    !["job", "timer", "ask", "broken"].includes(e.source) && !e.source.endsWith(":reply");
  const { mode } = setup.sorter;
  /**
   * The work lane: everything that is not the person's own message, one run at a time. An event from outside
   * not on an item is screened by the sorter first, and an event from outside waits the sorter's gap unless it
   * is urgent (SPEC part 4). Pending events for one session go to one run: a run cut short starts again in its
   * session, an event on an item goes on in the item's session, and the rest start a fresh one. While paused it
   * takes nothing, so the sorter is not asked either; after a resume each run is told it is catching up, and
   * once nothing is left the catch-up's tells may go.
   */
  const workLane = lane("work lane", () => {
    clearTimeout(gapping);
    if (paused()) return;
    attach(db, atDoors);
    const events = waiting(db, atDoors, session, true, true);
    if (events.length === 0 && pause?.to) {
      pause = undefined;
      wake();
    }
    const unsorted = events.find(
      (e) => mode !== "off" && outside(e) && e.item_id === null && e.answer === null,
    );
    if (unsorted)
      return async () => {
        if ((await screen(setup, db, unsorted)) === "noise" && mode === "on") mark(db, [unsorted.id], "done");
      };
    const at = (e: Event) =>
      outside(e) && !(mode === "on" && e.answer === "urgent") ? Date.parse(e.received_at) + gap : 0;
    const first = events.find((e) => at(e) <= Date.now());
    if (!first) {
      if (events.length > 0) gapping = setTimeout(workLane, Math.min(...events.map(at)) - Date.now());
      return;
    }
    // Never the main conversation: loading it would replay it into the person's open run and swap its gate.
    const of = (e: Event) => e.session ?? itemSession(db, e.item_id, session);
    const s = of(first);
    const batch = events.filter((e) => of(e) === s);
    const caught = pause?.to
      ? `Note from duck: ${person.name} paused you from ${pause.from} until ${pause.to}, so some of what came in meanwhile is stale; do what still matters. ${person.name} hears about this catch-up once, in one message for all of it.\n\n`
      : "";
    return () =>
      runIn(s, batch, workAt, caught + cameIn(batch), true, (_, run) => {
        attach(db, atDoors);
        keep(run);
      });
  });

  /**
   * The others lane (SPEC part 11): what others write at a door that answers them, one run at a time, each
   * thread in a session of its own that has the gate's others tools and none of goose's extensions, so no
   * shell and no file tools. What a run ends on is posted in its thread. An event that goes on a thread, or
   * an ask's outcome, resumes the thread's session.
   */
  const othersLane = lane("others lane", () => {
    if (paused()) return;
    const of = (e: Event) =>
      e.session ?? (e.about === null ? undefined : aboutSession(db, e.source, e.about));
    const key = (e: Event) => of(e) ?? e.about;
    const events = waiting(db, asked, undefined, false, true);
    const first = events[0];
    if (!first) return;
    const [s, k] = [of(first), key(first)];
    const batch = events.filter((e) => key(e) === k);
    const note = `Note from duck: this run answers someone other than ${person.name}. What you end it on goes to them where they wrote.\n\n`;
    return () =>
      runIn(s, batch, othersAt, note + cameIn(batch), false, async (s) => {
        const [answer, where] = [await lastSaid(s), othersIn(db, s)];
        if (answer && where) void answerOthers(coworker, where, answer);
      });
  });

  /** What the coworker last wrote in session `sessionId`. */
  async function lastSaid(sessionId: string) {
    const { data } = await goose.call("_goose/unstable/session/export", { sessionId });
    type Said = { role: string; content: { type: string; text?: string }[] };
    const last = (JSON.parse(data).conversation as Said[]).findLast((m) => m.role === "assistant");
    return last?.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n") ?? "";
  }

  /**
   * A fresh session for `job`'s `who`, its worker or checker, in `cwd` with a job's tools, prompted with
   * `text`, kept as a run: its last message, and the words of its cut where it reached a cap. Its run is
   * ended though the prompt throws.
   */
  async function fresh(job: Job, who: string, cwd: string, text: string) {
    const { sessionId } = await goose.call("session/new", { cwd, mcpServers: jobServers });
    workers.set(job.id, sessionId);
    const spend = { who, calls: 0, cost: 0, cut: undefined as string | undefined };
    spending.set(sessionId, spend);
    const run = runStarted(db, sessionId, []);
    let stop = "cut";
    try {
      stop = (await within(sessionId, run, text)).stopReason;
    } finally {
      runEnded(db, run, [], stop);
      spending.delete(sessionId);
    }
    return { said: await lastSaid(sessionId), cut: spend.cut };
  }

  /**
   * The job lanes (SPEC part 6): up to AT_ONCE jobs at once, oldest first, each round a fresh worker in the
   * job's own folder and, when the job is checked, a fresh checker. A round's end is an inbox event for the
   * session that started the job, unless the job was stopped. A job whose round throws waits to be taken again.
   */
  const jobLanes = Array.from({ length: AT_ONCE }, () =>
    lane("job lane", () => {
      if (paused()) return;
      const job = take(db);
      if (!job) return;
      return async () => {
        try {
          const folder = `${HOME}/jobs/${job.id}`;
          mkdirSync(join(home, "jobs", String(job.id)), { recursive: true });
          const item = useList(db, "read_list", { id: job.item_id });
          const worker = await fresh(job, "worker", folder, workerText(job, item, folder, person.name));
          // A worker cut at its cap ends the round unchecked.
          const checks = job.check && !worker.cut;
          if (checks && !moved(db, job, "checking")) return;
          const checker = checks
            ? await fresh(job, "checker", folder, checkerText(db, job, worker.said, folder, person.name))
            : undefined;
          const cut = worker.cut ?? checker?.cut;
          const [report, grade] = [worker.said, checker?.said];
          const end = { job: job.title, round: job.rounds, checked: job.check === 1, cut, report, grade };
          if (ended(db, job, cut)) add(db, "job", endRef(job), JSON.stringify(end), job.item_id, job.session);
        } finally {
          workers.delete(job.id);
          moved(db, job, "waiting");
        }
        wake();
      };
    }),
  );

  /**
   * The dispatcher (SPEC part 10): delivers the ask rows that may go as duck wrote them, wakes the main
   * conversation when tell rows may, and looks again once more may.
   */
  function dispatch() {
    clearTimeout(later);
    if (signal.aborted) return;
    const { rows, wait } = dueNow();
    for (const r of rows.filter((r) => r.kind === "ask"))
      settle(db, [r.id], deliver(coworker, r.text, performance.now()));
    if (rows.some((r) => r.kind === "tell")) wake();
    if (wait > 0) later = setTimeout(dispatch, wait);
  }

  /** Summarises the idle main conversation with duck's summary prompt, unless the person writes first. */
  async function compact() {
    compacting = Math.floor(Date.now() / 1000);
    try {
      const { stopReason } = await prompt("/compact");
      const { data } = await goose.call("_goose/unstable/session/export", { sessionId: session });
      // A compaction cancelled before goose saved its summary leaves its "/compact" last, for the model to read.
      // Once saved, the summary has hidden it and the truncate would delete the summary too, since goose
      // truncates by time (crates/goose/src/session/session_manager.rs:2945 at 1.59.0).
      if (JSON.parse(data).conversation.at(-1)?.metadata.agentVisible)
        await goose.call("_goose/unstable/session/conversation/truncate", {
          sessionId: session,
          truncateFrom: compacting,
        });
      // The summary may not hold the standing words, the notes' lines or the list, so the next run shows them.
      else seen.delete(session as string);
      console.log(JSON.stringify({ compaction: name, session, stop: stopReason }));
    } finally {
      compacting = null;
    }
  }

  /**
   * Wakes every lane, and returns when the person lane next rests: the run the wake starts or steers has ended,
   * and any after it. Where the person lane has something, its compaction stops and its run is steered.
   */
  function wake() {
    const rest = rested.promise;
    if (signal.aborted) return rest;
    attach(db, atDoors);
    if (waiting(db, doors, session).length > 0 || dueNow().rows.some((r) => r.kind === "tell")) {
      clearTimeout(timer);
      if (compacting !== null) goose.notify("session/cancel", { sessionId: session });
      else if (personLane.busy()) steer();
      else void personLane();
    }
    void workLane();
    void othersLane();
    for (const jobLane of jobLanes) void jobLane();
    return rest;
  }

  /**
   * Stops the coworker: its goose connection, its doors and its runs, which are left as a restart leaves them,
   * then its timers and its database. Its person's message waiting on a run is let go.
   */
  async function stop() {
    stopping.abort();
    clearInterval(every);
    await Promise.all([personLane, workLane, othersLane, ...jobLanes].map((l) => l.going()));
    rested.resolve();
    await Promise.allSettled([listening, coworker.sending]);
    for (const t of [timer, later, gapping]) clearTimeout(t);
    db.close();
  }

  dreaming(db, person.zone, setup.timers.dreaming);
  const every = setInterval(() => {
    tick(db, person.zone);
    lapse(db, person);
    wake();
  }, ms(setup.timers.every));
  const listening = listen(coworker);
  return coworker;
}

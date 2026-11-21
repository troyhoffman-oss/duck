import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { link, logged } from "./list";

// SPEC part 6. A job is waiting, working, checking, done or stopped, since the time in `since`; code writes
// both. Its title is the only name the coworker knows it by, and its id names its folder, which only its worker
// sees. Its progress is not a column: it is progress.md in that folder, which its worker keeps.
export const JOBS = `
create table if not exists jobs (id integer primary key, item_id integer not null, brief text not null,
  "check" integer not null, check_reason text not null, state text not null default 'waiting',
  rounds integer not null default 1, session text not null, title text, started_at text, since text);`;

export type Job = Record<"id" | "item_id" | "check" | "rounds", number> &
  Record<"brief" | "session" | "title" | "state" | "started_at" | "since", string>;

/** The most rounds a job has (SPEC part 6). */
const ROUNDS = 3;

/** The most jobs a coworker works at once (SPEC part 6). */
export const AT_ONCE = 5;

const LIVE = ["waiting", "working", "checking"];
const live = `state in ('waiting', 'working', 'checking')`;
const worked = `state in ('working', 'checking')`;
const now = () => new Date().toISOString();
/** A brief's first line, cut short: the title of a job started without one. */
const firstLine = (brief: string) => (brief.trim().split("\n")[0] ?? "").slice(0, 60);

/** duck's own job tools on the person and work lanes, which the gate serves. */
export const JOB_TOOLS = [
  {
    name: "start_job",
    description: `Starts a job on item \`item_id\`: a fresh worker does what \`brief\` asks, in a folder of its own, with your plugs' tools and none of yours, while you stay free. \`title\` is a few words naming it, its only name, which \`jobs\`, \`note_job\` and \`stop_job\` take. A brief says what is asked, what is known, its "done means" lines, when to stop and ask, and to mark anything it could not confirm. \`check\` is your choice at the fork, and there is no default: true has a fresh checker grade the result against each "done means" line. The firm's sign decides what gets checked; \`check_reason\` says why you chose. Up to ${AT_ONCE} jobs work at once, and one started beyond that waits and starts by itself. When the job ends, its report, and the checker's grade when checked, come to this session. Put a result where your person will find it, such as their Drafts, only after its check.`,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        item_id: { type: "integer" },
        brief: { type: "string" },
        check: { type: "boolean" },
        check_reason: { type: "string" },
      },
      required: ["item_id", "brief", "check", "check_reason"],
    },
  },
  {
    name: "jobs",
    description:
      "Where your jobs stand: each job not ended and each that ended in the last day, by title, with its item, whether it is waiting, working, checking, done or stopped and since when, its round, whether it is checked and the last lines of its progress.md.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "note_job",
    description: `Tells job \`title\` something: the answer to what it asked, a correction or more to do. A waiting job starts with it; a working one goes another round with it once the round under way ends; an ended one goes another round. A job has at most ${ROUNDS} rounds.`,
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, text: { type: "string" } },
      required: ["title", "text"],
    },
  },
  {
    name: "stop_job",
    description:
      "Stops job `title`: a waiting one never starts, a working one is cut off, and nothing more comes back from it. Its folder stays.",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
];

/**
 * After duck starts, nothing is being worked: every job not ended waits to be taken again. A job from a build
 * before titles is titled with its brief's first line.
 */
export function resume(db: Database) {
  for (const job of db.query<Job, []>("select * from jobs where title is null").all())
    db.run("update jobs set title = ?, started_at = ?, since = ? where id = ?", [
      firstLine(job.brief),
      now(),
      now(),
      job.id,
    ]);
  db.run(`update jobs set state = 'waiting', since = ? where state in ('running', 'working', 'checking')`, [
    now(),
  ]);
}

/** The job `title` names: the one not ended, or the latest that ended; refused where it fits several not ended. */
function named(db: Database, title: string) {
  const fits = db
    .query<Job, [string]>("select * from jobs where instr(lower(title), lower(?)) > 0 order by id desc")
    .all(title);
  const exact = fits.filter((j) => j.title.toLowerCase() === title.toLowerCase());
  const among = exact.length > 0 ? exact : fits;
  const going = among.filter((j) => LIVE.includes(j.state));
  if (going.length > 1)
    throw new Error(
      `"${title}" fits ${going.length} jobs: ${going.map((j) => `"${j.title}"`).join(", ")}. Give one's whole title.`,
    );
  const job = going[0] ?? among[0];
  if (!job) throw new Error(`No job is titled "${title}"; \`jobs\` lists them.`);
  return job;
}

/** Starts the job `input` gives for session `s`, and says what it did and how many work and wait. */
function startJob(db: Database, input: Record<string, unknown>, s: string | undefined) {
  if (typeof input.check !== "boolean" || !input.check_reason)
    throw new Error("A job needs `check`, true or false, and `check_reason`: the fork has no default.");
  if (!db.query("select 1 from items where id = ?").get(Number(input.item_id)))
    throw new Error(`there is no item ${input.item_id}`);
  const title = String(input.title ?? "").trim() || firstLine(String(input.brief));
  const same = db
    .query<Job, [string]>(`select * from jobs where lower(title) = lower(?) and ${live}`)
    .get(title);
  if (same)
    throw new Error(
      `"${title}" is already ${same.state}: tell it more with note_job, or name this one apart.`,
    );
  const { id, started_at } = db
    .query(
      `insert into jobs (item_id, title, brief, "check", check_reason, session, state, started_at, since)
        values (?, ?, ?, ?, ?, ?, 'waiting', ?, ?) returning id, started_at`,
    )
    .get(
      Number(input.item_id),
      title,
      String(input.brief),
      input.check ? 1 : 0,
      String(input.check_reason),
      s ?? null,
      now(),
      now(),
    ) as Job;
  const count = (where: string) =>
    (
      db
        .query<{ n: number }, [number]>(`select count(*) as n from jobs where ${where} and id < ?`)
        .get(id) as {
        n: number;
      }
    ).n;
  link(db, Number(input.item_id), [{ kind: "job", ref: `"${title}", started ${started_at}` }], "code");
  logged(db, Number(input.item_id), `Job "${title}" started, ${input.check ? "checked" : "not checked"}.`);
  const [working, ahead] = [count(worked), count("state = 'waiting'")];
  const when =
    working + ahead < AT_ONCE
      ? `It starts now${working === 0 ? "" : `, beside ${working} other ${working === 1 ? "job" : "jobs"}`}.`
      : `${AT_ONCE} jobs are working, so it waits behind ${ahead} and starts by itself when one ends.`;
  return `"${title}" is started. ${when} Its report comes to this session when it ends; until then you are free.`;
}

/** Adds `input`'s text to job `title`'s brief, for the round it waits for or the next. */
function noteJob(db: Database, input: Record<string, unknown>) {
  const job = named(db, String(input.title));
  const next = job.state === "waiting" ? job.rounds : job.rounds + 1;
  if (next > ROUNDS)
    throw new Error(
      `"${job.title}" has had its ${ROUNDS} rounds, the most a job has. Tell your person where it stands, with your doubt stated.`,
    );
  db.run(
    `update jobs set brief = brief || ?, rounds = ?, state = case when ${live} then state else 'waiting' end,
      since = case when ${live} then since else ? end where id = ?`,
    [`\n\nNote for round ${next}: ${input.text}`, next, now(), job.id],
  );
  if (job.state === "waiting") return `"${job.title}" starts with your note.`;
  if (LIVE.includes(job.state))
    return `"${job.title}" goes round ${next} with your note once the round under way ends.`;
  return `"${job.title}" goes round ${next} with your note.`;
}

/** Stops job `title`, and has `cut` cut off its worker or checker where one is at work. */
function stopJob(db: Database, input: Record<string, unknown>, cut: (job: number) => void) {
  const job = named(db, String(input.title));
  if (!LIVE.includes(job.state)) return `"${job.title}" is already ${job.state}.`;
  db.run("update jobs set state = 'stopped', since = ? where id = ?", [now(), job.id]);
  if (job.state !== "waiting") cut(job.id);
  return `"${job.title}" is stopped, and nothing more comes back from it. Its folder stays.`;
}

/** Every job not ended and each that ended in the last day, as `jobs` gives them, with `home`'s progress.md. */
function listJobs(db: Database, home: string) {
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const rows = db.query<Job, [string]>(`select * from jobs where ${live} or since >= ? order by id`).all(day);
  if (rows.length === 0) return "No job is waiting or working, and none ended in the last day.";
  return rows
    .map((j) => {
      const file = join(home, "jobs", String(j.id), "progress.md");
      const tail = existsSync(file)
        ? readFileSync(file, "utf8").trim().split("\n").slice(-5).join("\n  ")
        : "";
      const said = tail ? `\n  progress.md ends:\n  ${tail}` : "";
      return `- "${j.title}", on item ${j.item_id}: ${j.state} since ${j.since}, round ${j.rounds} of at most ${ROUNDS}, ${j.check ? "checked" : "not checked"}.${said}`;
    })
    .join("\n");
}

/**
 * Runs job tool `name` with `input`, called in session `s`, for the coworker whose home is `home`; `cut` cuts
 * off a stopped job's worker or checker. Returns its result's words.
 */
export function useJobs(
  db: Database,
  name: string,
  input: Record<string, unknown>,
  s: string | undefined,
  home: string,
  cut: (job: number) => void,
) {
  if (name === "start_job") return startJob(db, input, s);
  if (name === "note_job") return noteJob(db, input);
  if (name === "stop_job") return stopJob(db, input, cut);
  return listJobs(db, home);
}

/**
 * Takes the oldest waiting job for a job lane but those in `setAside`, after a round that threw, now
 * working, if any. One job's rounds so never overlap.
 */
export const take = (db: Database, setAside: number[] = []) =>
  db
    .query<Job, [string, string]>(
      "update jobs set state = 'working', since = ? where id = (select id from jobs where state = 'waiting' and id not in (select value from json_each(?)) order by id limit 1) returning *",
    )
    .get(now(), JSON.stringify(setAside));

/** Moves `job` to `state` while it is still worked; false once it was stopped, or has ended. */
export const moved = (db: Database, job: Job, state: string) =>
  db.run(`update jobs set state = ?, since = ? where id = ? and ${worked}`, [state, now(), job.id]).changes >
  0;

/**
 * Ends `job`'s round: done, or waiting for the round a note gave it meanwhile, and logs it on its item, with
 * `cut`'s words where a run was cut at its cap. False, and nothing done, once it was stopped.
 */
export function ended(db: Database, job: Job, cut?: string) {
  const ends = db.run(
    `update jobs set state = case when rounds = ? then 'done' else 'waiting' end, since = ? where id = ? and ${worked}`,
    [job.rounds, now(), job.id],
  ).changes;
  if (ends === 0) return false;
  logged(
    db,
    job.item_id,
    `Job "${job.title}" ended round ${job.rounds}, ${job.check ? "checked" : "not checked"}.${cut ? ` ${cut}` : ""}`,
  );
  return true;
}

const alone = (person: string) =>
  `You have your plugs' tools and none of your own: no list, no jobs and no \`tell\`, and nothing you write here reaches ${person}.`;

/** What a job's worker is given: who it is, the brief and item `item`'s document, in `folder`. */
export const workerText = (job: Job, item: string, folder: string, person: string) =>
  `Note from duck: this session is the worker on the job "${job.title}", which you started, in a fresh session. ${alone(person)} Work in ${folder}, the job's own folder, and keep progress.md there: what is done and what is next. If it is there already, the job was started before: read it and go on from it. Do not change the brief or the sign. Mark anything you could not confirm. Your last message is your report, and it goes to the session that started the job, under three headings: Blocked on me, Changed and Found.

The brief:
${job.brief}

The item:
${item}`;

/** The inbox event's ref for the end of `job`'s round `round`, which names no id. */
export const endRef = (job: Job, round = job.rounds) =>
  `"${job.title}", round ${round}, started ${job.started_at}`;

/** What a job's checker is given: the brief, the worker's `report`, and the grade of the round before, if any. */
export function checkerText(db: Database, job: Job, report: string, folder: string, person: string) {
  const before = db
    .query<{ payload: string }, [string]>("select payload from inbox where source = 'job' and ref = ?")
    .get(endRef(job, job.rounds - 1));
  const earlier = before && (JSON.parse(before.payload) as { grade?: string }).grade;
  return `Note from duck: this session checks the job "${job.title}", which a fresh worker did from the brief below, in ${folder}. ${alone(person)} Grade each "done means" line of the brief as met, not met or not confirmed, each with its evidence. Open the real thing, such as the file itself or the numbers recalculated: the report's word is not evidence. Your last message is your grade, and it goes with the report to the session that started the job.

The brief:
${job.brief}

The worker's report:
${report}${earlier ? `\n\nYour grade of the round before, which this round's changes answer:\n${earlier}` : ""}`;
}

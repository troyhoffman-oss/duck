import type { Database } from "bun:sqlite";
import { add } from "./inbox";
import { DREAMING } from "./setup";

// SPEC part 3. A fired follow-up is done: its `at` is null. Ids are never reused, so a firing's ref, the
// timer's id and the time it was due, names one firing only.
export const TIMERS = `
create table if not exists timers (id integer primary key autoincrement, at text, repeat text, item_id integer,
  note text not null);`;

type Timer = { id: number; at: string; repeat: string | null; item_id: number | null; note: string };

/** The next time cron expression `repeat` gives after `from`, read in time zone `zone`. */
const next = (repeat: string, zone: string, from: number) =>
  Bun.cron.parse(repeat, from, { tz: zone })?.toISOString() ?? null;

/**
 * The scheduler (SPEC part 3): adds an inbox event on the work lane for each timer due at `now`, and marks a
 * follow-up done or moves a repeat to its next time after `now`, so one due while duck was down fires once.
 */
export function tick(db: Database, zone: string, now = Date.now()) {
  for (const t of db
    .query<Timer, [string]>("select * from timers where at <= ?")
    .all(new Date(now).toISOString())) {
    add(db, "timer", `${t.id}@${t.at}`, JSON.stringify(t.note), t.item_id);
    db.run("update timers set at = ? where id = ?", [t.repeat ? next(t.repeat, zone, now) : null, t.id]);
  }
}

/** Runs timer tool `name` with `input` for a person in time zone `zone`, and returns its result's words. */
export function useTimers(db: Database, zone: string, name: string, input: Record<string, unknown>) {
  if (name === "remove_timer") {
    if (db.run("delete from timers where id = ?", [Number(input.id)]).changes === 0)
      throw new Error(`there is no timer ${input.id}`);
    return `Timer ${input.id} is removed.`;
  }
  const repeat = input.repeat === undefined ? null : String(input.repeat);
  const first = repeat ? next(repeat, zone, Date.now()) : null;
  const at = new Date(input.at === undefined ? (first ?? Number.NaN) : String(input.at));
  if (Number.isNaN(at.getTime())) throw new Error(`"${input.at}" is not a time`);
  const item = input.item_id === undefined ? null : Number(input.item_id);
  const row = db
    .query("insert into timers (at, repeat, item_id, note) values (?, ?, ?, ?) returning id")
    .get(at.toISOString(), repeat, item, String(input.note)) as { id: number };
  return `Timer ${row.id} is set for ${at.toISOString()}.`;
}

/** The timer tools, which the gate serves as duck's own on the person and work lanes. */
export const TIMER_TOOLS = [
  {
    name: "set_timer",
    description:
      "Sets a timer that wakes you with `note` at `at`, an ISO 8601 time with its offset: a follow-up for yourself, or a reminder your person asked for. With `item_id` the run goes on in that item's session. With `repeat`, a cron expression read in your person's time zone (`0 8 * * MON` is Mondays at 8), it fires again at each time the expression gives; `at` may then be left out for the expression's next time. The result names the timer's id, and an item's document lists its timers.",
    inputSchema: {
      type: "object",
      properties: {
        at: { type: "string" },
        note: { type: "string" },
        item_id: { type: "integer" },
        repeat: { type: "string" },
      },
      required: ["note"],
    },
  },
  {
    name: "remove_timer",
    description: "Removes timer `id`, which then never fires.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
];

/** The note of every dreaming timer (SPEC part 8). */
export const DREAM = `Time to dream: read ${DREAMING} and do what it says.`;

/** Makes sure dreaming has its one repeating timer, on cron expression `repeat` in time zone `zone`. */
export function dreaming(db: Database, zone: string, repeat = "0 3 * * *") {
  db.run("delete from timers where note = ? and repeat != ?", [DREAM, repeat]);
  if (!db.query("select 1 from timers where note = ? and repeat is not null").get(DREAM))
    useTimers(db, zone, "set_timer", { note: DREAM, repeat });
}

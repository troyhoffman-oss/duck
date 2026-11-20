import { join } from "node:path";
import type { When } from "./model";

/** The made-up firm's folder, whose setup every end-to-end test installs. */
export const HARBOR = join(import.meta.dir, "..", "..", "examples", "harbor");

type Setup = {
  zone: string;
  model: { coworker: string };
  sorter: { model: string };
  doors: Record<string, Record<string, unknown>>;
};
const setup = Bun.YAML.parse(await Bun.file(join(HARBOR, "duck.yaml")).text()) as Setup;
const [coworker, doors] = Object.entries(setup.doors)[0] as [string, Setup["doors"][string]];

/**
 * harbor's names: its coworker and its doors as its setup gives them, and the person the kit makes it for
 * and claims it as: their handle and their name.
 */
export const harbor = {
  coworker,
  person: "rosa",
  name: "Rosa Alvarez",
  /** The person's zone, the firm's. */
  zone: setup.zone,
  doors: Object.keys(doors),
  models: { ...setup.model, sorter: setup.sorter.model },
};

/**
 * duck's own tools that a test's model calls, with the inputs it gives them. Each name is a contract the
 * part that owns the tool builds to; each input uses its table's columns as SPEC.md names them.
 */
export const TOOLS = {
  /** Part 7: `items (id, title, state, holder, next, due, body)`, and its `links (kind, ref)`. */
  writeItem: "write_item",
  /** Part 6: `jobs (item_id, brief, check, check_reason)`; the fork's choice and reason are required. */
  startJob: "start_job",
  /** Part 10: a work-lane run that has something for the person writes a "tell" row: `text, item_id, urgent`. */
  tell: "tell",
  /** Part 3: `timers (at, repeat, item_id, note)`; its result names the timer's id. */
  setTimer: "set_timer",
  /** Part 3: removes timer `id`. */
  removeTimer: "remove_timer",
  /**
   * Part 9: the coworker's answer to a held call, `{ask, yes}`, where the gate's result for the held call
   * names `ask`. The gate takes it only from the main conversation, in a run started by the person's own
   * message that arrived after the question was delivered.
   */
  answer: "answer",
  /** Part 9: Buzz's own CLI as the coworker, `{args, input, files}`, where it has a buzz door. */
  buzz: "buzz",
};

/** A call of the sorter's cheap decision model (SPEC rule 10), through its decisions API. */
export const sorter: When = (r) => r.model === harbor.models.sorter;

/**
 * goose's compaction call: the coworker's model with no tools, which is how goose 1.59.0 sends it
 * (`complete_one_shot` with an empty tool list, crates/goose/src/context_mgmt/mod.rs).
 */
export const summary: When = (r) => r.model === harbor.models.coworker && r.tools.length === 0;

/** A run of the coworker itself, main conversation or work lane: it has the list's tool. */
export const coworkerRun: When = (r) => r.has(TOOLS.writeItem);

/** A job's worker or checker, which has tools but no list, no jobs and no send (SPEC rule 6, part 6). */
export const jobRun: When = (r) =>
  r.model === harbor.models.coworker && r.tools.length > 0 && !r.has(TOOLS.writeItem);

/** The first whole number in `text`, as the id a tool's result names. */
export function idIn(text: string): number {
  const found = /\b(\d+)\b/.exec(text);
  if (!found) throw new Error(`no id in "${text.slice(0, 200)}"`);
  return Number(found[1]);
}

/**
 * How long an end-to-end test may take, install included. Every wait inside one is shorter, so a test
 * that fails names what it waited for rather than timing out.
 */
export const E2E = 300_000;

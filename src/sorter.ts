import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { readSetup, type Setup, secret } from "./setup";

// SPEC part 4: each answer the sorter gave, by the inbox event it screened, read beside the run that took the
// event. `answer` is the likeliest of the choice's answers, or failed when the call failed; `why` is, as JSON,
// each answer's probability and that of "addresses AI", or why the call failed.
export const SORTER = `
create table if not exists sorter (event integer primary key, answer text not null, why text not null, at text not null);`;

type Screened = { source: string; ref: string; about?: string | null; received_at: string; payload: unknown };

/** An event as one line: what the sorter is given, and what the work lane shows the coworker. */
export const line = (e: Screened) =>
  `${e.source} ${e.ref}${e.about ? `, about ${e.about}` : ""}, received ${e.received_at}: ${typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload)}`;

/**
 * An event as code logs it on its item: what happened, by its source and payload. The log row has its own time,
 * and the item holds the event by its ref.
 */
export const logLine = (e: Screened) =>
  `${e.source}: ${typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload)}`;

/** The answers to the sorter's choice question, and the label its yes/no question asks for (SPEC part 4). */
const ANSWERS = ["noise", "wake", "urgent"];
const AI = "addresses AI";

/**
 * The sorter's file as its two questions: a line "- `noise`: text" says what that answer means, and so for
 * `wake` and `urgent`; the line "- `addresses AI`: text" is the yes/no question; the rest is the choice's
 * instructions. Throws when a line is missing.
 */
export function questions(file: string) {
  const named: Record<string, string> = {};
  const rest = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => {
      const [, name = "", text = ""] = /^- `([^`]+)`: (.+)$/.exec(l) ?? [];
      if (![...ANSWERS, AI].includes(name)) return true;
      named[name] = text;
      return false;
    });
  const missing = [...ANSWERS, AI].filter((name) => named[name] === undefined);
  if (missing.length > 0) throw new Error(`the sorter's file ${file} has no line for ${missing.join(", ")}`);
  return {
    answer: {
      type: "choice",
      instructions: rest.join("\n").trim(),
      criteria: Object.fromEntries(ANSWERS.map((a) => [a, named[a]])),
    },
    ai: { type: "noul", instructions: named[AI] },
  };
}

type Answers = {
  answer?: { choice?: string; probabilities?: Record<string, number> };
  ai?: { noul?: number };
};

/**
 * The firm's decision model's answers to `questions` about `state`: one call through its decisions API, logged
 * as `what`'s. The text it sent back comes with them, to name in a failure.
 */
export async function decide(setup: Setup, what: string, state: string, questions: object) {
  const { address, key, model, request } = setup.sorter;
  const started = performance.now();
  const response = await fetch(address, {
    method: "POST",
    headers: { authorization: `Bearer ${secret(setup, key)}`, "content-type": "application/json" },
    body: JSON.stringify({ ...request, model, state, questions }),
    // The work lane or a person's message waits on the call: one that hangs is failed after a minute.
    signal: AbortSignal.timeout(60_000),
  });
  const sent = await response.text();
  if (!response.ok) throw new Error(`the decision model answered ${response.status}: ${sent.slice(0, 300)}`);
  const { answers, usage } = JSON.parse(sent) as { answers?: Record<string, unknown>; usage?: unknown };
  // duck's log, as the model relay logs its calls: the tokens, and the cost where the API gives one.
  console.log(JSON.stringify({ [what]: model, usage, ms: Math.round(performance.now() - started) }));
  return { answers: answers ?? {}, sent };
}

/** The sorter's answer to `event`: one call of the firm's decision model, which wakes the coworker when it fails. */
async function ask(setup: Setup, event: Screened) {
  const { answers, sent } = await decide(setup, "sorter", line(event), questions(setup.sorter.file));
  const { answer, ai } = answers as Answers;
  if (!ANSWERS.includes(answer?.choice ?? "") || typeof ai?.noul !== "number")
    throw new Error(`the sorter's model gave no answer: ${sent.slice(0, 300)}`);
  return {
    answer: answer?.choice as string,
    why: JSON.stringify({ ...answer?.probabilities, [AI]: ai.noul }),
  };
}

/** Screens inbox event `e` and logs the answer. A call that fails is logged as failed, which wakes the coworker. */
export async function screen(setup: Setup, db: Database, e: Screened & { id: number }) {
  const { answer, why } = await ask(setup, e).catch((error: Error) => ({
    answer: "failed",
    why: error.message,
  }));
  db.run("insert or replace into sorter (event, answer, why, at) values (?, ?, ?, ?)", [
    e.id,
    answer,
    why,
    new Date().toISOString(),
  ]);
  return answer;
}

/** The sorter as replay scores it (test/replay/replay.ts): one case's event, judged for the firm in `firm`. */
export const sort = (c: { event?: Screened }, { firm }: { firm: string }) =>
  ask(readSetup(firm), c.event as Screened);

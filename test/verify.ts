import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROUTINES } from "./replay/replay";

const ROOT = join(import.meta.dir, "..");
/** SPEC rule 11: duck's own source, without goose and without tests, stays under 10,000 lines. */
const SRC_LIMIT = 10_000;
/** The tests a change to `src/` may only turn on and add to, never edit (SPEC, Tests). */
const JUDGES = ["test/e2e/", "test/property/"];

/**
 * Whether `after` keeps every line of `before` in order, each as it was or with `test.failing(` turned into
 * `test(`, and adds lines only above the file's first `describe(` or test, or after its last step: before the
 * `});` that closes a journey, or at the end of a file of tests.
 */
export function onlyAdded(before: string, after: string): boolean {
  const b = before.split("\n");
  const describe = b.findIndex((l) => l.startsWith("describe("));
  const head = describe >= 0 ? describe : b.findIndex((l) => /^test(\.failing)?\(/.test(l));
  const last = b.findLastIndex((l) => l !== "");
  const tail = describe >= 0 ? last : last + 1;
  let i = 0;
  for (const line of after.split("\n")) {
    const was = b[i];
    if (was !== undefined && (line === was || line === was.replace("test.failing(", "test("))) i++;
    else if (i > head && i < tail) return false;
  }
  return i === b.length;
}

function git(...args: string[]) {
  const done = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString().trim()}`);
  return done.stdout.toString();
}

/** What this change touches, against where it left origin/main: each path with its status, A M D or R. */
export function changes(): { status: string; path: string; from?: string }[] {
  const base = git("merge-base", "HEAD", "origin/main").trim();
  const listed = git("diff", "--name-status", "-M", base)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, first, second] = line.split("\t") as [string, string, string | undefined];
      return second === undefined
        ? { status: status.slice(0, 1), path: first }
        : { status: status.slice(0, 1), path: second, from: first };
    });
  const untracked = git("ls-files", "--others", "--exclude-standard")
    .split("\n")
    .filter(Boolean)
    .map((path) => ({ status: "A", path }));
  return [...listed, ...untracked];
}

/** The lines of every file under `src/`. */
function sourceLines(): number {
  const src = join(ROOT, "src");
  if (!existsSync(src)) return 0;
  let lines = 0;
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder)) {
      const path = join(folder, entry);
      if (statSync(path).isDirectory()) walk(path);
      else lines += readFileSync(path, "utf8").split("\n").length - 1;
    }
  };
  walk(src);
  return lines;
}

/** Runs a step with its output shown, and says whether it passed. */
function step(name: string, command: string[]): boolean {
  console.log(`\n== ${name}: ${command.join(" ")}`);
  return Bun.spawnSync(command, { cwd: ROOT, stdout: "inherit", stderr: "inherit" }).exitCode === 0;
}

async function main() {
  const failed: string[] = [];
  if (!step("check", ["bun", "run", "check"])) failed.push("bun run check");
  // The tests start containers, so they run only with --tests, where the test server's queue runs them.
  if (process.argv.includes("--tests")) {
    if (!step("tests", ["bun", "test"])) failed.push("bun test");
  } else
    console.log(
      "\n== tests: not run; run the test files that cover the change with `duck-test bun test <files>`, and the whole suite on main with `duck-test bun run verify --tests`",
    );

  const lines = sourceLines();
  console.log(
    `\n== size: src/ holds ${lines.toLocaleString("en-US")} lines (limit ${SRC_LIMIT.toLocaleString("en-US")})`,
  );
  if (lines > SRC_LIMIT) failed.push(`src/ is ${lines} lines, past ${SRC_LIMIT}`);

  console.log("\n== judges: a change to src/ may only turn on and add to the tests that judge it");
  const changed = changes();
  if (changed.some((c) => c.path.startsWith("src/")))
    for (const c of changed) {
      const judged = (p: string | undefined) => p !== undefined && JUDGES.some((j) => p.startsWith(j));
      if (!judged(c.path) && !judged(c.from)) continue;
      if (c.status === "A") continue;
      const base = git("merge-base", "HEAD", "origin/main").trim();
      const ok =
        c.status === "M" &&
        onlyAdded(git("show", `${base}:${c.path}`), readFileSync(join(ROOT, c.path), "utf8"));
      if (!ok)
        failed.push(
          `${c.from ?? c.path} is a test that judges src/, and this change ${c.status === "D" ? "deletes" : c.status === "R" ? "moves" : "edits"} it beyond turning test.failing( into test( and adding steps after its last`,
        );
    }
  console.log(failed.some((f) => f.includes("judges src/")) ? "  a judging test was edited" : "  ok");

  const judged = Object.values(ROUTINES).filter((r) => changed.some((c) => c.path === r.file));
  if (judged.length > 0) {
    console.log(
      `\n== replay, since ${judged.map((r) => r.file).join(", ")} changed (reported, never failing)`,
    );
    const folders = [
      join(ROOT, "examples", "harbor", "2026-11-20"),
      ...(process.env.DUCK_REPLAY_DAYS ?? "").split(":").filter(Boolean),
    ];
    for (const folder of folders)
      step(`replay ${relative(ROOT, folder) || folder}`, ["bun", "run", "replay", folder]);
  }

  console.log(
    failed.length === 0
      ? "\nverify: passed"
      : `\nverify: failed\n${failed.map((f) => `  - ${f}`).join("\n")}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.main) await main();

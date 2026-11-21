import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Setup } from "./setup";

/**
 * `lines` up to `cap` characters in all, then a line saying how many more there are in the file; with
 * `newest`, the last lines that fit, after a line saying how many older ones were left out.
 */
export function upTo(lines: string[], cap: number, newest = false) {
  let size = 0;
  const fits = (line: string) => {
    size += line.length + 1;
    return size <= cap;
  };
  const shown = newest ? lines.toReversed().filter(fits).toReversed() : lines.filter(fits);
  const left = lines.length - shown.length;
  if (left === 0) return shown.join("\n");
  return newest
    ? [`(${left} older lines are left out; each item's log holds them.)`, ...shown].join("\n")
    : [...shown, `(${left} more lines are past the size cap and not shown.)`].join("\n");
}

/** The standing words in `home`, and the first line of each notes file, each up to its cap in setup. */
export function memory(setup: Setup, home: string): [string, string] {
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").trim() : "");
  const folder = join(home, "notes");
  const files = existsSync(folder) ? readdirSync(folder, { recursive: true }).map(String).sort() : [];
  const lines = files
    .filter((f) => statSync(join(folder, f)).isFile())
    .map((f) => `notes/${f}: ${read(join(folder, f)).split("\n")[0]}`);
  const standing = read(join(home, "standing.md"));
  return [
    upTo(standing ? standing.split("\n") : [], setup.notes?.standing ?? 4000),
    upTo(lines, setup.notes?.lines ?? 4000),
  ];
}

/**
 * Keeps the version history of the standing words, the notes and the voice in `home` in the git folder
 * `folder`, which the coworker's container cannot write (SPEC part 8). Returns what commits a run's changes.
 */
export function history(folder: string, home: string) {
  const git = (...args: string[]) => {
    const done = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
    // git commit exits 1 when nothing changed.
    if (done.exitCode > 1) console.error(`git ${args.join(" ")}: ${done.stderr.toString().trim()}`);
  };
  git("init", "--quiet", "--bare", folder);
  writeFileSync(join(folder, "info", "exclude"), "/*\n!/standing.md\n!/notes/\n!/voice.md\n");
  const at = [
    `--git-dir=${folder}`,
    `--work-tree=${home}`,
    ..."-c user.name=duck -c user.email=duck@localhost".split(" "),
  ];
  return (run: number) => {
    git(...at, "add", "--all");
    git(...at, "commit", "--quiet", "--message", `run ${run}`);
  };
}

/** duck's own tool that writes the standing words, which only the main conversation has (SPEC part 8). */
export const STANDING_TOOL = {
  name: "standing",
  description:
    "Writes your person's standing words, their own instructions to you: `content` is the whole of standing.md as it is to be, every line you keep with the one you add or change. Only your conversation with your person has it, and standing.md is read-only to your file tools.",
  inputSchema: {
    type: "object",
    properties: { content: { type: "string" } },
    required: ["content"],
  },
};

/**
 * Writes `content` as the standing words in `home`, in place: the coworker's container holds the one file
 * read-only over its own path, and sees what is written there only while it stays the same file.
 */
export function writeStanding(home: string, content: string) {
  writeFileSync(join(home, "standing.md"), content);
  return "standing.md holds them now; the next run is shown them.";
}

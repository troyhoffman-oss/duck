---
name: verify
description: Run before every commit in duck. Runs the check, the size rule and the rule that a change never edits the test that judges it, and reports replay scores. A pull request runs the test files that cover its change on the test server's queue; the whole suite, with --tests, runs on main before each install.
---

# verify

Run `bun run verify` from the repo root before every commit; commit only when it ends `verify: passed`. It does not run the tests: they start containers and need the test server's queue. On the test server, `duck-test` is the queue's wrapper, and these run there. A pull request runs the test files that cover what it changed, `duck-test bun test <files>`: a journey the change adds steps to, or the property, replay or kit tests it touches. The whole suite, `duck-test bun run verify --tests`, runs on `main` before each install. Never run `bun test` or `--tests` on a shared or development machine.

It runs, in order:

1. `bun run check`: bun's type check and biome, zero findings.
2. With `--tests`, `bun test`: the whole suite. A step still written `test.failing(` passes only while it fails.
3. The size rule: `src/` stays at or under 10,000 lines (SPEC rule 11). It prints the count.
4. The judges rule: against `origin/main`, a change that touches `src/` keeps every line of each existing file under `test/e2e/` and `test/property/`, except to turn `test.failing(` into `test(`. It reads a journey file as one top-level `describe(` at column 0 with nothing but tests after it. A change may add tests: a new file, new steps after a journey's last step, or new tests at the end of a file of plain tests, with any lines they need above its first `describe(` or `test(`; lines after a journey's closing line are allowed too.
5. Replay scores, when the change touches a judged routine's file (`src/sorter.ts`, `src/jobs.ts`, `src/run/index.ts`). They are reported with the change and never fail it. Set `DUCK_REPLAY_DAYS` to a colon-separated list of folders of a firm's own recorded days to score those too; they live outside this repo.

## When it fails

Read the list after `verify: failed`; each line names its cause.

- **check or tests:** fix the cause in the code. A flaky test is fixed at its cause or removed, in a pull request of its own.
- **size:** make the source smaller. The limit holds.
- **judges:** put the test back as `origin/main` has it, keeping only `test.failing(` turned into `test(` and the steps you added after its last. If the test itself is wrong, stop, and fix it in a pull request of its own that touches no `src/` file.

# duck

duck is an open-source AI coworker that works on its own initiative. Each firm runs it on its own server. It runs goose unmodified.

[SPEC.md](SPEC.md) is the design: its words, its rules and its parts. Read it before changing a part. [ROADMAP.md](ROADMAP.md) holds the order of the build and where each part stands. This file holds the rules for working in this repo.

## Rules

- **The spec's words are the names.** Code, setup, messages and docs use the words in SPEC.md's table, one word per thing.
- **goose runs unmodified,** over ACP, at the version pinned in `package.json`. When goose can't do something, stop and report it.
- **A plug before code.** A new tool or source is a setup entry for an MCP server that already exists. Plug it in, measure the gap, and write code only for the gap, inside a box. The core never learns a plug's name.
- **Use what goose, MCP and Buzz already do.** Say what you checked in the pull request.
- **Nothing about one firm lives here.** Examples use the made-up firm in `examples/harbor/`. A firm's setup, names, brand and recorded days live in its own private repo.
- **One path per job.** A change that replaces a path deletes the old one in the same pull request.
- **Fewest lines.** Build what the spec sentence and its test require, on one straight path. A rare failure fails loudly and is written down; it gets code when someone using duck hits it.
- **Coworkers hold no keys.** Setup names secrets and never holds them. A key, token, connection string or webhook URL is named, never printed or committed.
- **Comments say only what the code can't:** a reason, or a constraint from outside the code.
- **Docs hold rules and contracts.** Status goes in ROADMAP.md.

## Layout

One package. Everything duck ships is under `src/`, and that is what the spec's size rule counts.

- `src/`: one file per part of SPEC.md, named for the part. A part that outgrows one file becomes a folder of the same name. `src/duck.ts` is the command.
- `test/e2e/`: one file per journey, a person's day told in steps: one firm start, then one step per behavior a person can see, each going on from the last.
- `test/property/`: the tables.
- `test/replay/`: the replay harness and its scorecard.
- `test/kit/`: what tests stand up in place of the outside: a scripted model, a plug, a person at a door.
- `examples/harbor/`: the made-up firm's setup, and a made-up recorded day.
- `.claude/skills/verify/`: the `verify` skill.

## Tests

- A part is done when its end-to-end tests pass on a running coworker.
- An end-to-end test installs the made-up firm with `duck install` and drives the real processes. Only the outside is stood in for, by the kit, and the firm's setup points at it. duck's source has no test-only path.
- An end-to-end test asserts on what a person or a plug sees, and on a table only where SPEC.md names it.
- A behavior a person can see lands with its end-to-end test in the same pull request.
- A pull request that changes source leaves every test already on `main` under `test/e2e/` and `test/property/` as it is, except to turn `test.failing(` into `test(`. It may add tests: a new file, new steps after a journey's last step, or new tests at the end of a file of plain tests, with any lines they need above its first `describe(` or `test(`; lines after a journey's closing line are allowed too. A wrong test is fixed in a pull request of its own. The kit may change with source.
- Replay tests score judgment. They never block a merge; their scores are reported with the change.
- A flaky test is fixed at its cause or removed.
- Run the `verify` skill before every commit.
- A pull request runs `bun run check` and the test files that cover what it changed, through the test server's queue. The whole suite runs on `main` before each install.

## Stack

- TypeScript on bun, every dependency pinned to an exact version.
- `bun run check` passes with zero findings before a commit.

## Git

- Every change lands through a pull request to `main`.
- Bring `main` into a branch by merging `origin/main`. History on a pushed branch is never rewritten.

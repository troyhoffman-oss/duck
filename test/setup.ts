import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test makes its folders under one folder of the run's own, which goes when the run ends, passed or
// failed, so no test file has to clean up after itself. A process a test starts makes its folders there
// too, since it inherits TMPDIR.
const root = mkdtempSync(join(tmpdir(), "duck-test-"));
process.env.TMPDIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

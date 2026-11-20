// A box on harbor's mail plug (SPEC part 9): a PDF the coworker gives the plug's tools asks first unless the
// plug handed it to the coworker byte for byte. The gate gives a box a context with each call: the file a
// call names, read as the gate reads it, and `state`, a folder of the coworker's boxes' own.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;
type Result = { content: { type: string; resource?: { blob?: string } }[] };
type Context = { read: (path: string) => Buffer; state: string };

const pdf = (bytes: Buffer) => bytes.subarray(0, 4).toString() === "%PDF";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const handed = (context: Context) => join(context.state, "handed-pdfs.txt");

/** Keeps the hash of each PDF the plug hands the coworker. */
export function after(_tool: string, _input: Json, result: Result, context: Context) {
  for (const c of result.content) {
    const bytes = Buffer.from(c.resource?.blob ?? "", "base64");
    if (pdf(bytes)) appendFileSync(handed(context), `${hash(bytes)}\n`);
  }
  return result;
}

/** Asks first, saying why, before the plug is given a PDF it did not hand the coworker. */
export function askFirst(_tool: string, input: Json, context: Context) {
  if (typeof input.file !== "string") return false;
  const bytes = context.read(input.file);
  const kept = existsSync(handed(context)) ? readFileSync(handed(context), "utf8").split("\n") : [];
  return (
    pdf(bytes) &&
    !kept.includes(hash(bytes)) &&
    "This PDF is not one harbor's mail handed the coworker: it was made or changed since."
  );
}

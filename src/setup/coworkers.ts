import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  checkName,
  type Facts,
  factsFile,
  factsOf,
  keysFile,
  lacking,
  made,
  plugKeys,
  readSetup,
  type Setup,
  secret,
} from ".";

export const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** Writes `text` at `path` whole or not at all, so a reader never sees half of it. */
export function write(path: string, text: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.new`, text, { mode });
  renameSync(`${path}.new`, path);
}

export const writeFacts = (setup: Setup, coworker: string, facts: Facts) =>
  write(factsFile(setup, coworker), `${JSON.stringify(facts, null, 2)}\n`);

/** Refuses `handle` where it is not one word, which a secret's name can hold, or another coworker has it. */
function checkHandle(setup: Setup, coworker: string, handle: string) {
  if (!/^\w+$/.test(handle)) throw new Error(`"${handle}" is not a handle: letters, digits and underscores`);
  const taken = made(setup).find((c) => c !== coworker && factsOf(setup, c).handle === handle);
  if (taken) throw new Error(`coworker ${taken} is already for ${handle}`);
}

/** The public key of coworker `coworker`'s own Buzz key, in hex. */
export const buzzKey = (setup: Setup, coworker: string) =>
  hex(schnorr.getPublicKey(Buffer.from(secret(setup, "BUZZ_KEY", coworker), "hex")));

/**
 * Makes coworker `name` in the setup in `folder`, for the person `handle` names where given (SPEC part 1): its
 * facts, unclaimed, and a Buzz key of its own, in its folder. A folder duck kept from before keeps what it
 * holds. Where given, `person` is the Buzz key of the person duck offers it to. Returns the Buzz key's public
 * key, which its person's claim signs.
 */
export function make(folder: string, name: string, handle?: string, person?: string) {
  const setup = readSetup(folder);
  checkName(name);
  if (existsSync(factsFile(setup, name))) throw new Error(`duck has made coworker ${name} already`);
  // A claim in duck's DM gives no handle, so a coworker made for a person has theirs now; "" is no handle.
  if (handle !== undefined || person) checkHandle(setup, name, handle ?? "");
  // Made for a person, it is claimed and installed with no admin there, so the keys its plugs need are here first.
  const missing = person ? lacking(setup, plugKeys(setup, name, handle)) : [];
  if (missing.length > 0)
    throw new Error(
      `the secret store has no ${missing.join(" or ")}, which ${name}'s plugs need for ${handle}`,
    );
  if (!existsSync(keysFile(setup, name)))
    write(keysFile(setup, name), `BUZZ_KEY=${hex(schnorr.utils.randomSecretKey())}\n`, 0o600);
  const at = new Date().toISOString();
  writeFacts(setup, name, {
    handle: handle ?? null,
    owner: null,
    name: null,
    state: "unclaimed",
    made_at: at,
    claimed_at: null,
    ...(person && { for: person }),
  });
  return buzzKey(setup, name);
}

/** Whether NIP-OA auth tag `tag` is its owner's signature over Buzz key `key`, as buzz-sdk's nip_oa.rs checks. */
export function signs(tag: string[], key: string) {
  const [kind, owner = "", conditions = "", signature = ""] = tag;
  const signed = createHash("sha256").update(`nostr:agent-auth:${key}:${conditions}`).digest();
  try {
    return (
      kind === "auth" && schnorr.verify(Buffer.from(signature, "hex"), signed, Buffer.from(owner, "hex"))
    );
  } catch {
    return false;
  }
}

/**
 * Claims coworker `name` for the person named `person` whose NIP-OA auth tag `tag` signs its Buzz key (SPEC
 * part 11, Claim), with `handle` where its maker gave none, or claims a stopped one again for its own person.
 * A claim with no handle, or another key's tag, or, for a coworker made for a person, a tag that person did
 * not sign, is refused.
 */
export function claim(setup: Setup, name: string, tag: string, person: string, handle?: string) {
  if (!made(setup).includes(name))
    throw new Error(`duck has not made coworker ${name}; make it with duck make`);
  if (!person.trim()) throw new Error(`the claim gives no name for coworker ${name}'s person`);
  const facts = factsOf(setup, name);
  if (facts.state === "claimed") throw new Error(`coworker ${name} is claimed already`);
  const proof = JSON.parse(tag);
  if (!signs(proof, buzzKey(setup, name)))
    throw new Error(`the claim's tag does not sign coworker ${name}'s Buzz key`);
  // Buzz keeps the owner it first saw for a key (SPEC part 11), so a stopped coworker goes back to its own.
  if (facts.state === "stopped" && proof[1] !== JSON.parse(facts.owner ?? "[]")[1])
    throw new Error(`coworker ${name} is stopped, and only its own person may claim it again`);
  if (facts.for && proof[1] !== facts.for)
    throw new Error(`coworker ${name} was made for another person in Buzz than the claim's`);
  if (facts.handle && handle && handle !== facts.handle)
    throw new Error(`coworker ${name} is for ${facts.handle}, not ${handle}`);
  const given = facts.handle ?? handle;
  if (!given) throw new Error(`coworker ${name} is for nobody yet: give the person's handle with the claim`);
  checkHandle(setup, name, given);
  const at = new Date().toISOString();
  writeFacts(setup, name, {
    ...facts,
    handle: given,
    owner: tag,
    name: person,
    state: "claimed",
    claimed_at: at,
  });
}

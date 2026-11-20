import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { connect, type Event } from "./buzz";
import { type Item, shown } from "./list";
import { monthCosts, monthOf } from "./model-relay";
import {
  container,
  factsOf,
  installFile,
  jobCalls,
  made,
  ms,
  personOf,
  type SETTINGS,
  type Setup,
  secret,
  setting,
  settingsFile,
  settingsOf,
} from "./setup";
import { buzzKey, claim, hex, signs, write, writeFacts } from "./setup/coworkers";

/** duck's one answer in its DMs, in fixed words (SPEC part 11, duck's DM). */
export const ANSWER =
  "I'm duck, the service your firm's coworkers run on. I answer every message here with these same words. To talk with your coworker, write to it in its own DM.";

/** duck's offer of coworker `name`, whose Buzz key is `key`, to the person it was made for; the plugin reads it. */
const offerOf = (name: string, key: string) =>
  `Your firm made a coworker for you: ${name}. To make it yours, in Buzz's desktop app (the phone app cannot) with duck's plugin: open Agents, press New agent (and Create a new agent if it asks), choose duck as the harness, name it, press Create agent and then Let’s go. Without the plugin: open Settings, then Security, then Authorize external identity (Security is under Buzz in Settings' list), put this key in Application public key (hex), press Authorize identity and then Authorize this key:\n${key}\nThen press Copy ownership proof and paste the proof here as your reply.`;

/**
 * duck's answers to a proof pasted in its DM: one that claims a coworker, one from the person a claimed coworker
 * was made for whose proof signs its key, and one that claims nothing.
 */
const YOURS =
  "That coworker is yours now. duck is starting it, and it answers in its own DM once it is running.";
const MINE = "That coworker is yours already.";
const NOT_FIT = "That proof does not fit a coworker made for you here, so nothing changed.";

/**
 * What a coworker's person may ask of duck for it in its DM, in fixed words (SPEC part 11, duck's DM): a new
 * name, a new picture at an HTTPS address, or that it stop. Buzz's desktop asks the same through the plugin.
 */
const FORM =
  /^(?:rename ([a-z][a-z0-9-]*) to (.+)|picture ([a-z][a-z0-9-]*) (https:\/\/\S+)|remove ([a-z][a-z0-9-]*))$/;
const PUBLISHED = "Done: that coworker's profile in Buzz shows it now.";
const STOPPED =
  "That coworker is stopped. duck keeps its memory, and it comes back as it was when you claim it again.";
const NOT_YOURS = "That names no coworker of yours here, so nothing changed.";

/**
 * Its person's settings for a coworker, in fixed words (SPEC part 1, Settings): pause or resume it, its quiet
 * hours or none, and at most how many messages an hour it sends outside them.
 */
const SETTING =
  /^(?:(pause|resume) ([a-z][a-z0-9-]*)|set ([a-z][a-z0-9-]*) (?:quiet (none|(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d)|messages ([1-9]|[1-5]\d|60) per hour))$/;
const PAUSED =
  "That coworker is paused: it does no work on its own until you resume it, and it still answers you.";
const RESUMED =
  "That coworker is resumed: it catches up on what came in while it was paused and tells you about it once.";
const SET = "Done: that coworker's setting is changed.";
const LOCKED = "Your firm sets that for every coworker, so nothing changed.";

/** The firm's most model calls of a job's one fresh run (SPEC part 6), which an owner or admin sets. */
const LIMIT = /^set model calls per job ([1-9]\d{0,3})$/;
const LIMITED = "Done: a job's run is cut off at that many model calls from its next call.";
const NOT_ADMIN = "Only an owner or admin of this community sets that, so nothing changed.";

const OFF = "duck's DM is off: the setup holds no ownership proof of duck's Buzz key; duck check says how";

/** duck's own Buzz key, in hex, in a file in its storage that only duck reads, made the first time it is asked for. */
function duckKey(setup: Setup) {
  const file = join(setup.storage.folder, "keys.env");
  if (!existsSync(file)) write(file, `BUZZ_KEY=${hex(schnorr.utils.randomSecretKey())}\n`, 0o600);
  return readFileSync(file, "utf8").trim().slice("BUZZ_KEY=".length);
}

/** Whether `owner`, an ownership proof as Buzz copies it, signs Buzz key `key`. */
function proves(owner: string | undefined, key: string) {
  try {
    return signs(JSON.parse(owner ?? "[]"), key);
  } catch {
    return false;
  }
}

/** duck's own Buzz key's public key, in hex. */
const duckPublic = (setup: Setup) => hex(schnorr.getPublicKey(Buffer.from(duckKey(setup), "hex")));

const STEPS =
  "in Buzz's desktop app the community's owner or an admin opens Settings, then Security, then Authorize external identity (Security is under Buzz in Settings' list), puts that key in Application public key (hex), presses Authorize identity and then Authorize this key, presses Copy ownership proof and puts the proof in duck.yaml as buzz.owner in single quotes, since Buzz copies it as a JSON list";

/** What is wrong with duck's own identity where the firm has Buzz: a proof in the setup that does not sign its key. */
export function identityProblems(setup: Setup) {
  if (!setup.buzz?.owner) return [];
  const key = duckPublic(setup);
  return proves(setup.buzz.owner, key)
    ? []
    : [`buzz.owner does not sign duck's own Buzz key ${key}: ${STEPS}`];
}

/** What is still to do where the firm has Buzz and the setup holds no proof of duck's own identity yet. */
export function identityToDo(setup: Setup) {
  return setup.buzz && !setup.buzz.owner
    ? [
        `still to do: duck's Buzz key is ${duckPublic(setup)}; ${STEPS}. Until then duck's DM is off, and coworkers are made and claimed with duck make and duck claim`,
      ]
    : [];
}

/** duck's own identity in Buzz where the setup's proof signs its key; with none, duck's DM is off. */
export function identity(setup: Setup) {
  const owner = setup.buzz?.owner;
  if (setup.buzz && owner && proves(owner, duckPublic(setup)))
    return { key: duckKey(setup), owner, relay: setup.buzz.relay };
}

/**
 * duck in its DMs (SPEC part 11, duck's DM), once the setup's proof signs its key: a person's message that is an
 * ownership proof is a claim, one in a fixed form changes a coworker of theirs, and any other gets the one fixed
 * answer; each coworker made for a person is offered to them, at start and when `duck make` says (SIGHUP). A
 * message that carries an owner's tag is an agent's, and gets none, so duck and an agent never answer each other
 * for ever. Claims, changes and offers go one at a time, since the connection asks one query at a time; the
 * fixed answer waits on nothing.
 */
export function talk(setup: Setup) {
  const me = identity(setup);
  if (!me) return setup.buzz && console.error(OFF);
  let sending = Promise.resolve();
  /** `step` once the claims, changes and offers before it are done. */
  const after = (step: () => Promise<string>) => {
    const done = sending.then(step);
    sending = done.then(() => {}).catch(() => {});
    return done;
  };
  const duck = connect(me, (message, place) => {
    if (place.type !== "dm" || message.tags.some((t) => t[0] === "auth")) return;
    const proof = proofIn(message.content);
    const form = FORM.exec(message.content.trim());
    const set = SETTING.exec(message.content.trim());
    const limit = LIMIT.exec(message.content.trim());
    const words = proof
      ? after(() => claimFrom(setup, duck, message.pubkey, proof))
      : form
        ? after(() => change(setup, message.pubkey, form))
        : set
          ? after(() => setFor(setup, duck, message.pubkey, set))
          : limit
            ? after(() => limitJobs(setup, duck, message.pubkey, Number(limit[1])))
            : Promise.resolve(ANSWER);
    words
      .then((text) => duck.send(9, [["h", place.channel]], text))
      .catch((e: Error) => console.error(`an answer: ${e.message}`));
  });
  const offerAll = () => {
    sending = sending
      .then(() => offer(setup, duck))
      .catch((e: Error) => console.error(`duck's offers: ${e.message}`));
  };
  process.on("SIGHUP", offerAll);
  offerAll();
  const due = new Set<string>();
  // Writes that land while a coworker's list waits its turn go out with it.
  listed = (name) => {
    if (due.has(name)) return;
    due.add(name);
    after(async () => {
      due.delete(name);
      await publishList(setup, duck, name, lists.get(name) as Database);
      await publishSettings(setup, duck, name);
      return "";
    }).catch((e: Error) => console.error(`${name}'s list in Buzz: ${e.message}`));
  };
  for (const name of lists.keys()) listed(name);
  let firmDue = false;
  // A change the admins' card shows goes out with any that land while it waits its turn.
  firmChanged = () => {
    if (firmDue) return;
    firmDue = true;
    after(async () => {
      firmDue = false;
      await publishFirm(setup, duck);
      return "";
    }).catch((e: Error) => console.error(`the firm's coworkers in Buzz: ${e.message}`));
  };
  firmChanged();
  // What changes on its own, a run or a cost, goes out at most once in ten minutes, and only where it changed:
  // the admins' card, and each person's list and preferences.
  setInterval(() => {
    firmChanged();
    for (const name of running.keys()) listed(name);
  }, 600_000);
  // The plugin finds duck by this profile, and trusts it where its owner's tag names an owner or admin.
  duck
    .send(
      0,
      [],
      JSON.stringify({ name: "duck", about: "The service your firm's coworkers run on.", duck: true }),
    )
    .catch((e: Error) => console.error(`duck's profile: ${e.message}`));
}

/**
 * Each running coworker, by its name: its database, which its list is read from, whether its goose is up, and
 * what wakes it.
 */
type Running = ReadonlyMap<string, { db: Database; up(): boolean; wake(): unknown }>;
let running: Running = new Map();
/** Has duck publish what the firm's admins see in turn; nothing while duck's DM is off. */
let firmChanged = () => {};

/**
 * Tells duck the coworkers it runs now, `coworkers`, and has it publish what the firm's admins see: at start,
 * when a coworker starts, stops or its goose comes up.
 */
export function coworkersChanged(coworkers: Running) {
  running = coworkers;
  firmChanged();
}

/** Each running coworker's database, by its name, which its list is read from. */
const lists = new Map<string, Database>();
/** Has duck publish coworker `name`'s list in turn; nothing while duck's DM is off. */
let listed = (_name: string) => {};

/**
 * Publishes coworker `name`'s list, on its database `db`, to its person in their DM with duck, where only they
 * and duck read it (SPEC part 11, The plugin): at start and after each write to it.
 */
export function listChanged(name: string, db: Database) {
  lists.set(name, db);
  listed(name);
}

/**
 * Where an item of coworker `name`'s shows in its person's To-dos: an open or waiting item whose next step its
 * person holds needs them, named as the coworker knows them, in full or by their first name; any other open
 * item is the coworker's own work; any other waiting item waits on someone else; a done item is folded away.
 */
function groupOf(item: Item, person: string) {
  const holder = item.holder?.trim().toLowerCase();
  if (item.state === "done") return "done";
  if (holder && [person, person.split(" ")[0]].some((n) => n?.toLowerCase() === holder)) return "you";
  return item.state === "waiting" ? "waiting" : "doing";
}

/** The NIP-AR id of the artifact of `type` keyed `key` in channel `h`, as NIP-AR derives one (a UUIDv8). */
function artifactId(h: string, type: string, key: string) {
  const id = createHash("sha256").update(`nip-ar-artifact\0${h}\0${type}\0${key}`).digest().subarray(0, 16);
  id[6] = ((id[6] as number) & 0x0f) | 0x80;
  id[8] = ((id[8] as number) & 0x3f) | 0x80;
  return id.toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
}

/**
 * Writes the artifact (NIP-AR) of `type` keyed `key`, titled `title`, with `content`, in the DM of the person
 * whose Buzz key is `to` with duck, unless it would not change; `tags` add to it.
 */
async function publishArtifact(
  duck: ReturnType<typeof connect>,
  to: string,
  key: string,
  [type, title, content]: [string, string, string],
  tags: string[][] = [],
) {
  const opened = await duck.send(41010, [["p", to]], "");
  const dm = JSON.parse(opened.slice("response:".length)).channel_id;
  const d = artifactId(dm, type, key);
  const [head] = await duck.query({ artifact: "current", "#h": [dm], "#d": [d] });
  if (head?.content === content) return;
  const envelope = Object.entries({ ar: "1", d, h: dm, type, title });
  const op = head
    ? [
        ["op", "update"],
        ["prev", head.id],
      ]
    : [["op", "create"]];
  await duck.send(45010, [...envelope, ...op, ...tags], content);
}

/** Writes claimed coworker `name`'s artifact in its person's DM with duck, naming the coworker's Buzz key. */
async function publishFor(
  setup: Setup,
  duck: ReturnType<typeof connect>,
  name: string,
  artifact: [string, string, string],
) {
  const { owner, state } = factsOf(setup, name);
  if (state !== "claimed" || !owner) return;
  await publishArtifact(duck, JSON.parse(owner)[1], name, artifact, [["agent", buzzKey(setup, name)]]);
}

/** The key the relay at `relay` signs its own events with, such as its member list, from its NIP-11 document. */
async function relayKey(relay: string) {
  const nip11 = await fetch(relay.replace(/^ws/, "http"), {
    headers: { accept: "application/nostr+json" },
    signal: AbortSignal.timeout(10_000),
  });
  return ((await nip11.json()) as { self: string }).self;
}

/** The owners and admins of the community, by the member list its relay signs (NIP-43), as Buzz reads it. */
async function admins(setup: Setup, duck: ReturnType<typeof connect>) {
  const signer = await relayKey(setup.buzz?.relay ?? "");
  const [members] = await duck.query({ kinds: [13534], authors: [signer], limit: 1 });
  return (members?.tags ?? [])
    .filter(([tag, , role]) => tag === "member" && (role === "owner" || role === "admin"))
    .map(([, key]) => key as string);
}

/**
 * Publishes what the firm's admins see, as one `duck.firm` artifact in each owner's and admin's DM with duck:
 * each coworker's person, state, whether its goose is up, when it last ran and its cost this calendar month,
 * and the most model calls of a job's run.
 */
async function publishFirm(setup: Setup, duck: ReturnType<typeof connect>) {
  const costs = monthCosts(setup);
  const coworkers = made(setup).map((name) => {
    const { name: person, state } = factsOf(setup, name);
    const own = running.get(name);
    const ran = own?.db.query<{ at: string | null }, []>("select max(started_at) as at from runs").get()?.at;
    return {
      name,
      person: person || null,
      state: state ?? "unclaimed",
      up: own?.up() ?? false,
      last_ran: ran ?? null,
      cost: Math.round((costs.get(name) ?? 0) * 100) / 100,
    };
  });
  const content = JSON.stringify({
    version: 1,
    month: monthOf(new Date(), setup.zone),
    model_calls_per_job: jobCalls(setup) ?? null,
    coworkers,
  });
  for (const admin of await admins(setup, duck))
    await publishArtifact(duck, admin, "firm", ["duck.firm", "Your firm's coworkers", content]);
}

/**
 * Sets the firm's most model calls of a job's run to `calls`, where `writer` is an owner or admin of the
 * community, in the file only duck writes, and publishes what the admins see (SPEC part 6).
 */
async function limitJobs(setup: Setup, duck: ReturnType<typeof connect>, writer: string, calls: number) {
  if (!(await admins(setup, duck)).includes(writer)) return NOT_ADMIN;
  write(settingsFile(setup), `${JSON.stringify({ ...settingsOf(setup), jobs: { calls } }, null, 2)}\n`);
  await publishFirm(setup, duck).catch((e: Error) =>
    console.error(`the firm's coworkers in Buzz: ${e.message}`),
  );
  return LIMITED;
}

/** Publishes coworker `name`'s list, on its database `db`, as its `duck.list` artifact. */
async function publishList(setup: Setup, duck: ReturnType<typeof connect>, name: string, db: Database) {
  const person = personOf(setup, name).name;
  const items = shown(db).map((i) => ({
    group: groupOf(i, person),
    ...Object.fromEntries(
      (["id", "title", "state", "holder", "next", "due", "updated_at"] as const).map((f) => [f, i[f]]),
    ),
  }));
  const content = JSON.stringify({ version: 1, items });
  await publishFor(setup, duck, name, ["duck.list", `${name}'s to-dos`, content]);
}

/**
 * Publishes coworker `name`'s settings as its `duck.person` artifact: each with its value and whether the firm
 * locks it, messages an hour as its person names them, and its cost this calendar month (SPEC part 1, Cost).
 */
async function publishSettings(setup: Setup, duck: ReturnType<typeof connect>, name: string) {
  const of = (key: (typeof SETTINGS)[number]) => ({
    value: setting(setup, name, key) ?? null,
    locked: setup.settings.locked?.includes(key) ?? false,
  });
  const each = of("one_message_per");
  // SPEC part 10 gives the limit's default, an hour.
  const every = ms((each.value as string | null) ?? "1h");
  // A whole number from one an hour up, so each n from 1 to 60 a person sets reads back as n.
  const perHour = every <= 3_600_000 ? Math.round(3_600_000 / every) : Math.round(36_000_000 / every) / 10;
  const content = JSON.stringify({
    version: 1,
    coworker: name,
    paused: { ...of("paused"), value: Boolean(of("paused").value) },
    quiet: of("quiet"),
    messages_per_hour: { ...each, value: perHour },
    cost: Math.round((monthCosts(setup).get(name) ?? 0) * 100) / 100,
  });
  await publishFor(setup, duck, name, ["duck.person", `${name}'s preferences`, content]);
}

/**
 * Changes the setting `set` names of the coworker it names, where `writer` is its person and the firm does
 * not lock it, in the file only duck writes, and publishes its settings (SPEC part 1, Settings). A pause keeps
 * when it began, and a resume wakes the coworker, so its catch-up starts at once.
 */
async function setFor(
  setup: Setup,
  duck: ReturnType<typeof connect>,
  writer: string,
  [, verb, coworkerToPause, coworkerToSet, quiet, perHour]: string[],
) {
  const name = (coworkerToPause ?? coworkerToSet) as string;
  const facts = made(setup).includes(name) ? factsOf(setup, name) : undefined;
  if (!facts?.owner || JSON.parse(facts.owner)[1] !== writer || facts.state !== "claimed") return NOT_YOURS;
  const key = verb ? "paused" : quiet ? "quiet" : "one_message_per";
  if (setup.settings.locked?.includes(key)) return LOCKED;
  const value = verb
    ? verb === "pause" && (setting(setup, name, "paused") || new Date().toISOString())
    : quiet
      ? quiet === "none"
        ? null
        : quiet.split("-")
      : `${Math.round(3600 / Number(perHour))}s`;
  write(
    settingsFile(setup, name),
    `${JSON.stringify({ ...settingsOf(setup, name), [key]: value }, null, 2)}\n`,
  );
  if (verb === "resume") running.get(name)?.wake();
  await publishSettings(setup, duck, name).catch((e: Error) =>
    console.error(`${name}'s settings in Buzz: ${e.message}`),
  );
  return verb === "pause" ? PAUSED : verb === "resume" ? RESUMED : SET;
}

/**
 * Does what `form` asks for coworker it names, where `writer` is its person: publishes its profile with the
 * new name or picture, or stops it, keeping its folder, and has the host install (SPEC part 11, duck's DM).
 */
async function change(
  setup: Setup,
  writer: string,
  [, renamed, called, pictured, picture, removed]: string[],
) {
  const name = (renamed ?? pictured ?? removed) as string;
  const facts = made(setup).includes(name) ? factsOf(setup, name) : undefined;
  if (!facts?.owner || JSON.parse(facts.owner)[1] !== writer || (facts.state !== "claimed" && !removed))
    return NOT_YOURS;
  if (removed) {
    if (facts.state === "claimed") {
      writeFacts(setup, name, { ...facts, state: "stopped" });
      writeFileSync(installFile(setup), "");
    }
    return STOPPED;
  }
  writeFacts(setup, name, { ...facts, ...(called ? { called: called.trim() } : { picture }) });
  await publish(setup, name);
  return PUBLISHED;
}

let publishing = Promise.resolve();

/**
 * Publishes claimed coworker `name`'s profile in Buzz, signed by its own key with its owner's tag, which marks
 * it an agent for Buzz's apps. It starts from the profile Buzz shows now and changes only what its person gave
 * it in Buzz: the name, where Buzz's apps show one, and the picture. With no profile yet, its name is the one its
 * admin made it with. A profile that would not change is not sent. Buzz keeps the newer of two profiles by the
 * second each was signed in (NIP-01), so profiles go one at a time, each in a second of its own, and each reads
 * the facts as they are when it goes.
 */
export function publish(setup: Setup, name: string) {
  const done = publishing.then(async () => {
    const { owner, called, picture } = factsOf(setup, name);
    if (!setup.buzz || !owner) return;
    const coworker = connect(
      { key: secret(setup, "BUZZ_KEY", name), owner, relay: setup.buzz.relay },
      () => {},
    );
    const update = async () => {
      const [shown] = (await coworker.query({ kinds: [0], authors: [buzzKey(setup, name)] })).sort(
        (a, b) => b.created_at - a.created_at,
      );
      const was = contentOf(shown);
      const given = called ?? (shown ? undefined : name);
      // Buzz's apps show display_name before name (buzz-app src/features/relay/profiles.ts:60-61).
      const now = {
        ...was,
        ...(given && { name: given, ...("display_name" in was && { display_name: given }) }),
        ...(picture && { picture }),
      };
      if (shown && JSON.stringify(now) === JSON.stringify(was)) return;
      await Bun.sleep(1000 - (Date.now() % 1000));
      await coworker.send(0, [], JSON.stringify(now));
    };
    try {
      await Promise.race([
        update(),
        Bun.sleep(30_000).then(() => Promise.reject(new Error("the relay took no profile in 30 s"))),
      ]);
    } finally {
      coworker.close();
    }
  });
  publishing = done.catch(() => {});
  return done;
}

/** What profile `event` says, or nothing where it says nothing a profile can. */
function contentOf(event?: Event): Record<string, unknown> {
  try {
    const content = JSON.parse(event?.content ?? "{}");
    return content && typeof content === "object" && !Array.isArray(content) ? content : {};
  } catch {
    return {};
  }
}

/** Offers each unclaimed coworker made for a person and not yet offered, in their DM with duck; sent once taken. */
async function offer(setup: Setup, duck: ReturnType<typeof connect>) {
  for (const name of made(setup)) {
    const facts = factsOf(setup, name);
    if (facts.state !== "unclaimed" || !facts.for || facts.offered_at) continue;
    try {
      const opened = await duck.send(41010, [["p", facts.for]], "");
      const dm = JSON.parse(opened.slice("response:".length)).channel_id;
      await duck.send(9, [["h", dm]], offerOf(name, buzzKey(setup, name)));
      writeFacts(setup, name, { ...factsOf(setup, name), offered_at: new Date().toISOString() });
    } catch (e) {
      console.error(`${name}'s offer, sent again at duck's next start: ${(e as Error).message}`);
    }
  }
}

/** The ownership proof Buzz copies, where `text` is that and nothing else: a JSON list of four, "auth" first. */
function proofIn(text: string) {
  try {
    const tag = JSON.parse(text);
    if (Array.isArray(tag) && tag.length === 4 && tag[0] === "auth") return tag as string[];
  } catch {}
}

/**
 * Claims for `writer`, with `claim`'s own checks, the unclaimed coworker made for them whose Buzz key `proof`
 * signs, named as their Buzz profile names them, and leaves the empty file that has the host run duck install
 * (SPEC part 11, Claim). Returns duck's answer: for the person a claimed coworker was made for, whose proof signs
 * its key, that it is theirs already; for every other proof that claims nothing, the same words.
 */
async function claimFrom(setup: Setup, duck: ReturnType<typeof connect>, writer: string, proof: string[]) {
  const name = made(setup).find((c) => factsOf(setup, c).for === writer && signs(proof, buzzKey(setup, c)));
  if (!name) return NOT_FIT;
  if (factsOf(setup, name).state === "claimed") return MINE;
  // A relay that never answers names the person by their handle, not stopping every claim after this one.
  const profiles = await Promise.race([
    duck.query({ kinds: [0], authors: [writer] }),
    Bun.sleep(10_000).then(() => []),
  ]);
  const profile = profiles.find((p) => p.pubkey === writer);
  const person = (profile && nameOf(profile)) || (factsOf(setup, name).handle ?? "");
  try {
    claim(setup, name, JSON.stringify(proof), person);
  } catch (e) {
    console.error(`a claim in duck's DM: ${(e as Error).message}`);
    return NOT_FIT;
  }
  writeFileSync(installFile(setup), "");
  return YOURS;
}

/** The name a profile gives, trimmed, as its person wrote it. */
function nameOf(profile: Event) {
  try {
    const { display_name, name } = JSON.parse(profile.content);
    return `${display_name || name || ""}`.trim();
  } catch {
    return "";
  }
}

/**
 * The Buzz key of the person `given` names, as the running duck finds it (`duck member`): a 64-character key as
 * it is, or the one person, not an agent, whose Buzz name it is without regard to case.
 */
export async function member(setup: Setup, given: string) {
  const me = identity(setup);
  if (!me) throw new Error(OFF);
  if (/^[0-9a-f]{64}$/.test(given)) return given;
  const wanted = given.trim().toLowerCase();
  const people = (await connect(me, () => {}).query({ kinds: [0] })).filter(
    (p) => wanted !== "" && !p.tags.some((t) => t[0] === "auth") && nameOf(p).toLowerCase() === wanted,
  );
  const keys = [...new Set(people.map((p) => p.pubkey))];
  const found = `${keys.length} people in Buzz are named "${given.trim()}"; give their 64-character Buzz key instead`;
  if (keys.length !== 1) throw new Error(found);
  return keys[0] as string;
}

/**
 * The key of the person `member` names for `duck make`, which the firm's running duck looks up, as only it
 * reaches Buzz as duck; with duck's DM off, or that duck not running, it refuses.
 */
export function personFor(setup: Setup, member: string) {
  if (!identity(setup)) throw new Error(OFF);
  const ask = ["podman", "exec", container(setup.firm), "bun", "src/duck.ts", "member", member];
  const asked = Bun.spawnSync(ask, { stdout: "pipe", stderr: "pipe" });
  if (asked.exitCode === 0) return asked.stdout.toString().trim();
  if (asked.exitCode === 1)
    throw new Error(asked.stderr.toString().trim() || "duck could not reach Buzz in 30 s");
  throw new Error("duck's DM is off while the firm's duck container is not running; duck install starts it");
}

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
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
  zoneOf,
} from "./setup";
import { buzzKey, claim, identity, signs, write, writeFacts } from "./setup/coworkers";
import { rezone } from "./timers";

/**
 * duck's answers to the ownership proof the plugin sends: one that claims a coworker, one from the person a
 * claimed coworker was made for whose proof signs its key, and one that claims nothing.
 */
const YOURS =
  "That coworker is yours now. duck is starting it, and it answers in its own DM once it is running.";
const MINE = "That coworker is yours already.";
const NOT_FIT = "That proof does not fit a coworker made for you here, so nothing changed.";

/**
 * What a coworker's person may ask of duck for it through the plugin, in fixed words (SPEC part 11, duck's
 * channel): a new name, a new picture at an HTTPS address, or that it stop.
 */
const FORM =
  /^(?:rename ([a-z][a-z0-9-]*) to (.+)|picture ([a-z][a-z0-9-]*) (https:\/\/\S+)|remove ([a-z][a-z0-9-]*))$/;
const PUBLISHED = "Done: that coworker's profile in Buzz shows it now.";
const STOPPED =
  "That coworker is stopped. duck keeps its memory, and it comes back as it was when you claim it again.";
const NOT_YOURS = "That names no coworker of yours here, so nothing changed.";

/**
 * Its person's settings for a coworker, in fixed words (SPEC part 1, Settings): pause or resume it, its quiet
 * hours or none, at most how many messages an hour it sends outside them, and their time zone.
 */
const SETTING =
  /^(?:(pause|resume) ([a-z][a-z0-9-]*)|set ([a-z][a-z0-9-]*) (?:quiet (none|(?:[01]\d|2[0-3]):[0-5]\d-(?:[01]\d|2[0-3]):[0-5]\d)|messages ([1-9]|[1-5]\d|60) per hour|zone (\S+)))$/;
const PAUSED =
  "That coworker is paused: it does no work on its own until you resume it, and it still answers you.";
const RESUMED =
  "That coworker is resumed: it catches up on what came in while it was paused and tells you about it once.";
const SET = "Done: that coworker's setting is changed.";
const LOCKED = "Your firm sets that for every coworker, so nothing changed.";
const NOT_A_ZONE = (zone: string) =>
  `"${zone}" is not a time zone; write one such as America/Chicago, so nothing changed.`;

/** The firm's most model calls of a job's one fresh run (SPEC part 6), which an owner or admin sets. */
const LIMIT = /^set model calls per job ([1-9]\d{0,3})$/;
const LIMITED = "Done: a job's run is cut off at that many model calls from its next call.";
const NOT_ADMIN = "Only an owner or admin of this community sets that, so nothing changed.";

const OFF =
  "duck's channels are off: the setup holds no ownership proof of duck's Buzz key; duck check says how";

/** First value of tag `name` on `event`, or "". */
const tagOf = (event: Event, name: string) => event.tags.find((t) => t[0] === name)?.[1] ?? "";

/**
 * duck in its channels (SPEC part 11, duck's channel), once the setup's proof signs its key: a person's request
 * (a `duck.request` artifact the plugin writes) that is an ownership proof is a claim, and one in a fixed form
 * changes a coworker of theirs; duck answers each with its revision of that request, in fixed words. Each
 * coworker made for a person is offered to them, at start and when `duck make` says (SIGHUP). The writer is the
 * key that signed the request, which the relay takes only from that key signed in (NIP-42), and duck takes a
 * request only in the channel it made for that writer. One that carries an owner's tag is an agent's and gets
 * no answer, nor does a revision of a request or one in no form duck knows. Claims, changes,
 * offers and what duck publishes go one at a time, since the connection asks one query at a time.
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
  const duck = connect(me, (asked, label) => {
    if (tagOf(asked, "type") !== "duck.request" || tagOf(asked, "op") !== "create" || tagOf(asked, "auth"))
      return;
    const [text, writer] = [asked.content.trim(), asked.pubkey];
    const [proof, form, set, limit] = [proofIn(text), FORM.exec(text), SETTING.exec(text), LIMIT.exec(text)];
    after(async () => {
      if (writer !== label) throw new Error("its channel is not its writer's");
      if (proof) return claimFrom(setup, duck, writer, proof);
      if (form) return change(setup, writer, form);
      if (set) return setFor(setup, duck, writer, set);
      if (limit) return limitJobs(setup, duck, writer, Number(limit[1]));
      throw new Error("it is in no form duck knows");
    })
      .then((answer) =>
        revise(duck, [tagOf(asked, "h"), tagOf(asked, "d")], ["duck.request", "Request", answer], asked),
      )
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
  duck
    .send(0, [], JSON.stringify({ name: "duck", about: "The service your firm's coworkers run on." }))
    .catch((e: Error) => console.error(`duck's profile: ${e.message}`));
}

/**
 * Each running coworker, by its name: its database, which its list is read from, whether its goose is up, and
 * what wakes it.
 */
type Running = ReadonlyMap<string, { db: Database; up(): boolean; wake(): unknown }>;
let running: Running = new Map();
/** Has duck publish what the firm's admins see in turn; nothing while duck's channels are off. */
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
/** Has duck publish coworker `name`'s list in turn; nothing while duck's channels are off. */
let listed = (_name: string) => {};

/**
 * Publishes coworker `name`'s list, on its database `db`, to its person in their channel with duck (SPEC part
 * 11, The plugin): at start and after each write to it.
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
 * The channel of the person whose Buzz key is `to` with duck (NIP-CL): a private system channel duck made with
 * them as its one other member, labelled with their key, which Buzz's apps list nowhere and count nothing in as
 * unread. duck makes it the first time it writes there; with more than one, every reader takes the oldest.
 */
async function channelFor(duck: ReturnType<typeof connect>, to: string) {
  const known = await duck.channel(to);
  if (known) return known;
  const id = randomUUID();
  const made = { h: id, name: "duck", channel_type: "system", visibility: "private", t: to, p: to };
  await duck.send(9007, Object.entries(made), "");
  await duck.refresh();
  return (await duck.channel(to)) ?? id;
}

/**
 * Writes artifact `d` in channel `h` (NIP-AR) of `type`, titled `title`, with `content`: a revision of `head`
 * where given, else its first; `tags` add to it.
 */
const revise = (
  duck: ReturnType<typeof connect>,
  [h, d]: [string, string],
  [type, title, content]: [string, string, string],
  head?: Event,
  tags: string[][] = [],
) =>
  duck.send(
    45010,
    [
      ...Object.entries({ ar: "1", d, h, type, title }),
      ...(head ? Object.entries({ op: "update", prev: head.id }) : [["op", "create"]]),
      ...tags,
    ],
    content,
  );

/**
 * Writes the artifact (NIP-AR) of `type` keyed `key`, titled `title`, with `content`, in the channel of the
 * person whose Buzz key is `to` with duck, unless it would not change; `tags` add to it.
 */
async function publishArtifact(
  duck: ReturnType<typeof connect>,
  to: string,
  key: string,
  artifact: [string, string, string],
  tags: string[][] = [],
) {
  const h = await channelFor(duck, to);
  const d = artifactId(h, artifact[0], key);
  const [head] = await duck.query({ artifact: "current", "#h": [h], "#d": [d] });
  // Its person may revise it too, so only duck's own revision is taken as unchanged.
  if (head?.content !== artifact[2] || head.pubkey !== duck.me)
    await revise(duck, [h, d], artifact, head, tags);
}

/** Writes claimed coworker `name`'s artifact in its person's channel with duck, naming its Buzz key. */
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
 * Publishes what the firm's admins see, as one `duck.firm` artifact in each owner's and admin's channel with
 * duck: each coworker's person, state, whether its goose is up, when it last ran and its cost this calendar
 * month, and the most model calls of a job's run.
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
    zone: of("zone"),
    cost: Math.round((monthCosts(setup, personOf(setup, name).zone).get(name) ?? 0) * 100) / 100,
  });
  await publishFor(setup, duck, name, ["duck.person", `${name}'s preferences`, content]);
}

/**
 * Changes the setting `set` names of the coworker it names, where `writer` is its person and the firm does
 * not lock it, in the file only duck writes, and publishes its settings (SPEC part 1, Settings). A pause keeps
 * when it began, and a resume wakes the coworker, so its catch-up starts at once. A new zone moves its repeating
 * timers to their next time there, and has the host install, which gives its container and harness the zone.
 */
async function setFor(
  setup: Setup,
  duck: ReturnType<typeof connect>,
  writer: string,
  [, verb, coworkerToPause, coworkerToSet, quiet, perHour, zone]: string[],
) {
  const name = (coworkerToPause ?? coworkerToSet) as string;
  const facts = made(setup).includes(name) ? factsOf(setup, name) : undefined;
  if (!facts?.owner || JSON.parse(facts.owner)[1] !== writer || facts.state !== "claimed") return NOT_YOURS;
  const key = verb ? "paused" : quiet ? "quiet" : zone ? "zone" : "one_message_per";
  if (setup.settings.locked?.includes(key)) return LOCKED;
  if (zone && !zoneOf(zone)) return NOT_A_ZONE(zone);
  const value = verb
    ? verb === "pause" && (setting(setup, name, "paused") || new Date().toISOString())
    : quiet
      ? quiet === "none"
        ? null
        : quiet.split("-")
      : zone
        ? zoneOf(zone)
        : `${Math.round(3600 / Number(perHour))}s`;
  write(
    settingsFile(setup, name),
    `${JSON.stringify({ ...settingsOf(setup, name), [key]: value }, null, 2)}\n`,
  );
  if (verb === "resume") running.get(name)?.wake();
  if (zone) {
    const db = running.get(name)?.db;
    if (db) rezone(db, value as string);
    writeFileSync(installFile(setup), "");
  }
  await publishSettings(setup, duck, name).catch((e: Error) =>
    console.error(`${name}'s settings in Buzz: ${e.message}`),
  );
  return verb === "pause" ? PAUSED : verb === "resume" ? RESUMED : SET;
}

/**
 * Does what `form` asks for coworker it names, where `writer` is its person: publishes its profile with the
 * new name or picture, or stops it, keeping its folder, and has the host install (SPEC part 11, duck's
 * channel).
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

/**
 * Offers each coworker made for a person, in their channel with duck, as its `duck.offer` artifact naming its
 * Buzz key, which the plugin shows in New agent; it stays there, so one stopped can be added again.
 */
async function offer(setup: Setup, duck: ReturnType<typeof connect>) {
  for (const name of made(setup)) {
    const { for: person } = factsOf(setup, name);
    if (!person) continue;
    const content = JSON.stringify({ version: 1, coworker: name });
    await publishArtifact(
      duck,
      person,
      name,
      ["duck.offer", `${name}, made for you`, content],
      [["agent", buzzKey(setup, name)]],
    ).catch((e: Error) => console.error(`${name}'s offer, sent again at duck's next start: ${e.message}`));
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
  // A relay that does not answer in time names the person by their handle.
  const profiles = await duck.query({ kinds: [0], authors: [writer] }).catch(() => []);
  const profile = profiles.find((p) => p.pubkey === writer);
  const person = (profile && nameOf(profile)) || (factsOf(setup, name).handle ?? "");
  try {
    claim(setup, name, JSON.stringify(proof), person);
  } catch (e) {
    console.error(`a claim: ${(e as Error).message}`);
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
 * reaches Buzz as duck; with duck's channels off, or that duck not running, it refuses.
 */
export function personFor(setup: Setup, member: string) {
  if (!identity(setup)) throw new Error(OFF);
  const ask = ["podman", "exec", container(setup.firm), "bun", "src/duck.ts", "member", member];
  const asked = Bun.spawnSync(ask, { stdout: "pipe", stderr: "pipe" });
  if (asked.exitCode === 0) return asked.stdout.toString().trim();
  if (asked.exitCode === 1)
    throw new Error(asked.stderr.toString().trim() || "duck could not reach Buzz in 30 s");
  throw new Error(
    "duck's channels are off while the firm's duck container is not running; duck install starts it",
  );
}

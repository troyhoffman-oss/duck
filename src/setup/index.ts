import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join, posix, resolve } from "node:path";
import { KINDS } from "../list";
import { routes } from "../model-relay";
import { loginProblems } from "../model-relay/claude-login";
import { questions } from "../sorter";

/**
 * A coworker's door. At an `http` door, `key` names the secret both sides send. At a `text` door, `address`
 * is the line's project at Photon's Spectrum, `line` the line's https:// address, `key` names the project's
 * secret and `auth` the person's own handle as Photon writes it, the one sender it takes. At an `email` door,
 * `address` is the mail service's API, `mailbox` the coworker's own address there, `key` names the secret of
 * a key to that mailbox and `auth` the person's own mail address. At a `voice` door, a call in Buzz, `address`
 * is the speech model's live API, `model` and `voice` what it speaks with and `key` names the secret of its key.
 * At a `telegram` door, `address` is the Bot API's, `key` names the secret of the bot's token and `auth` the
 * person's own Telegram user id. Every claimed coworker has a `buzz` door, which duck makes, at the setup's relay; it answers anyone who
 * mentions the coworker where its `answers` is `anyone`, and otherwise only its owner.
 */
export type Door = {
  kind: string;
  address: string;
  key: string;
  auth?: string;
  line?: string;
  mailbox?: string;
  answers?: string;
  model?: string;
  voice?: string;
};

/**
 * What duck's code writes about a coworker in its own folder (SPEC part 1): what `{person}` becomes, its
 * owner's NIP-OA auth tag once claimed, its person's name, its state and when it was made and claimed. A
 * stopped coworker keeps its owner and runs nothing until its person claims it again.
 */
export type Facts = {
  handle: string | null;
  owner: string | null;
  name: string | null;
  state: "unclaimed" | "claimed" | "stopped";
  made_at: string;
  claimed_at: string | null;
  /** The Buzz key of the person it was made for. */
  for?: string;
  /** The name and picture, an HTTPS address, its person gave it in Buzz, which its profile shows. */
  called?: string;
  picture?: string;
};

/**
 * A plug (SPEC part 1): its MCP address and its headers, each naming its secrets as `${NAME}` and the person
 * of the coworker that calls it as `{person}`, the coworkers it is given to, each tool's state where it is not
 * free, with `*` for every tool it does not name, each tool's state in a run that answers someone other than
 * the person, as `tools` names them but with what it does not name removed, and its boxes' files in the setup
 * folder.
 */
export type Plug = {
  address: string;
  headers?: Record<string, string>;
  coworkers: string[] | "everyone";
  tools?: Record<string, string>;
  others?: Record<string, string>;
  /**
   * `push` names the secret a source that can push sends; `poll` is how duck lists one that cannot, with the
   * field of a row that is its ref and, if any, the field that says what it is about.
   */
  events?: { push?: string; poll?: { tool: string; every: string; id: string; about?: string } };
  /**
   * What an ok result of each tool it names made, which duck links to the item the work is for (SPEC part
   * 7): the link's kind, the result's field that is the thing's id, the kind and field of what it belongs
   * to, if any, and the field of the result or else the input that labels it, if any.
   */
  makes?: Record<
    string,
    { kind: string; id: string; about?: { kind: string; field: string }; label?: string }
  >;
  boxes?: string[];
};

/**
 * A coworker's person: their name, their zone, their quiet hours there as two HH:MM times or none, their
 * message limit, and when they paused it, or null while it is not paused.
 */
export type Person = {
  name: string;
  zone: string;
  quiet: [string, string] | null;
  one_message_per?: string;
  paused?: string | null;
};

/** What a coworker's person may change of its settings in the plugin, which the setup may lock (SPEC part 1). */
export type Settings = {
  /** When its person paused it, or false. */
  paused?: string | false;
  quiet?: [string, string] | null;
  one_message_per?: string;
  /** Its person's time zone; the firm's is the default. */
  zone?: string;
  jobs?: { calls?: number };
};
export const SETTINGS = ["paused", "quiet", "one_message_per", "zone"] as const;

/** The states a tool can have in setup (SPEC part 9). */
const TOOL_STATES = ["free", "ask first", "removed"];

/** The sorter's modes (SPEC part 4). */
const SORTER_MODES = ["off", "observe", "on"];

/** The parts of a firm's `duck.yaml` this build reads (SPEC part 1). */
export type Setup = {
  firm: string;
  /** The firm's time zone, and each coworker's person's where they set none. */
  zone: string;
  listen: string;
  storage: { folder: string };
  secrets: { file: string };
  /**
   * The S3-compatible bucket each coworker is copied to, the names of the secrets that hold its key, its secret
   * and the password its copies are encrypted with; `at` is a cron expression in the firm's zone.
   */
  backup: { bucket: string; endpoint: string; key: string; secret: string; password: string; at?: string };
  /** `address` and `key` are the api-key route's; `login` is the claude-login route's home folder for `claude`. */
  model: { route: string; address?: string; key?: string; login?: string; coworker: string };
  sign: string;
  /**
   * The sorter (SPEC part 4): its file of questions in the setup folder, its mode, the gap events that pass it
   * wait, and its decision model's route: the address of its decisions API, the name of the secret that holds
   * its key, the model's name, and fields the firm's provider needs in every request.
   */
  sorter: {
    file: string;
    mode: string;
    gap: string;
    address: string;
    key: string;
    model: string;
    request?: Record<string, unknown>;
  };
  compaction: { idle: string };
  /** How often the scheduler looks at the timers (SPEC part 3), and when dreaming repeats, in cron. */
  timers: { every: string; dreaming?: string };
  /**
   * The most characters of the standing words, of the notes files' lines, and of the lines the open items'
   * logs gained, a run is shown.
   */
  notes?: { standing?: number; lines?: number; log?: number };
  /**
   * The most model calls of a job's one fresh run, its worker's or its checker's, by the model relay's count
   * (SPEC part 6), until an admin sets another in the plugin's Coworkers card. With none named there is none.
   */
  jobs?: { calls?: number };
  /** The firm's default for each coworker's settings (SPEC part 1, Settings). */
  settings: { quiet: [string, string]; one_message_per?: string; answers?: string; locked?: string[] };
  /**
   * The firm's Buzz relay, where each claimed coworker has its buzz door, and the states of the commands of
   * Buzz's CLI that its `buzz` tool runs, named by their leading words, with `*` for the rest (SPEC part 9).
   */
  buzz?: { relay: string; tools?: Record<string, string> };
  plugs?: Record<string, Plug>;
  /** The doors a named coworker has beyond its buzz door. */
  doors?: Record<string, Record<string, Door>>;
};

/** The setup in `folder`, its paths made absolute. */
export function readSetup(folder: string): Setup {
  const setup = Bun.YAML.parse(readFileSync(join(folder, "duck.yaml"), "utf8")) as Setup;
  setup.storage.folder = resolve(folder, setup.storage.folder);
  setup.secrets.file = resolve(folder, setup.secrets.file);
  setup.sign = resolve(folder, setup.sign);
  setup.sorter.file = resolve(folder, setup.sorter.file);
  if (setup.model.login) setup.model.login = resolve(folder, setup.model.login);
  for (const plug of Object.values(setup.plugs ?? {}))
    plug.boxes = plug.boxes?.map((b) => resolve(folder, b));
  return setup;
}

/** Where duck keeps coworker `coworker`'s facts, and its keys, which only duck reads, in its own folder. */
export const factsFile = (setup: Setup, coworker: string) =>
  join(setup.storage.folder, coworker, "coworker.json");
export const keysFile = (setup: Setup, coworker: string) => join(setup.storage.folder, coworker, "keys.env");
/** The empty file a claim from Buzz leaves for the host's duck install; with a dot, no coworker is named so. */
export const installFile = (setup: Setup) => join(setup.storage.folder, "install.wanted");
/** When the running duck found its Buzz key an admin, while it is one; with a dot, no coworker is named so. */
export const adminFile = (setup: Setup) => join(setup.storage.folder, "admin.since");

/**
 * The settings coworker `coworker`'s person changed, or with none, the firm's admins, which only duck's code
 * writes; the rest are the setup's.
 */
export const settingsFile = (setup: Setup, coworker = "") =>
  join(setup.storage.folder, coworker, "settings.json");
export const settingsOf = (setup: Setup, coworker = ""): Settings =>
  existsSync(settingsFile(setup, coworker))
    ? JSON.parse(readFileSync(settingsFile(setup, coworker), "utf8"))
    : {};

/** The most model calls of a job's one fresh run, read at each call: what an admin set, or the setup's. */
export const jobCalls = (setup: Setup) => settingsOf(setup).jobs?.calls ?? setup.jobs?.calls;

/** Coworker `coworker`'s setting `key`: the firm's where the setup locks it or its person never changed it. */
export function setting<K extends (typeof SETTINGS)[number]>(setup: Setup, coworker: string, key: K) {
  const own = settingsOf(setup, coworker);
  const firm: Settings = { paused: false, ...setup.settings, zone: setup.zone };
  return setup.settings.locked?.includes(key) || !(key in own) ? firm[key] : own[key];
}

export const factsOf = (setup: Setup, coworker: string): Facts =>
  JSON.parse(readFileSync(factsFile(setup, coworker), "utf8"));

/** The coworkers duck has made, by the folders that hold their facts. */
export const made = (setup: Setup) =>
  existsSync(setup.storage.folder)
    ? readdirSync(setup.storage.folder)
        .filter((name) => existsSync(factsFile(setup, name)))
        .sort()
    : [];

/** Refuses `name` where it is not a coworker's name, which its folder, containers and copies are named by. */
export function checkName(name: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error(
      `"${name}" is not a coworker's name: lowercase letters, digits and dashes, from a letter`,
    );
}

/** The coworkers that have been claimed, which are the ones that run. */
export const claimed = (setup: Setup) => made(setup).filter((c) => factsOf(setup, c).state === "claimed");

/**
 * Coworker `coworker`'s person: their name, and its settings, read each time they are looked at, so what its
 * person changes in the plugin holds from the outbox's next look.
 */
export const personOf = (setup: Setup, coworker: string): Person => ({
  name: factsOf(setup, coworker).name ?? "",
  get zone() {
    return setting(setup, coworker, "zone") as string;
  },
  get quiet() {
    return setting(setup, coworker, "quiet") ?? null;
  },
  get one_message_per() {
    return setting(setup, coworker, "one_message_per");
  },
  get paused() {
    return setting(setup, coworker, "paused") || null;
  },
});

/** IANA time zone `zone` as Intl names it, such as America/Chicago, or undefined where it is none. */
export function zoneOf(zone: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {}
}

/** Whether `plug` is given to `coworker`. */
export const gives = (plug: Plug, coworker: string) =>
  plug.coworkers === "everyone" || (Array.isArray(plug.coworkers) && plug.coworkers.includes(coworker));

/** Coworker `coworker`'s doors: those the setup names for it, and its buzz door where the firm has a relay. */
export const doorsOf = (setup: Setup, coworker: string): Record<string, Door> => ({
  ...setup.doors?.[coworker],
  ...(setup.buzz && {
    buzz: {
      kind: "buzz",
      address: setup.buzz.relay,
      key: "BUZZ_KEY",
      ...(setup.settings.answers === "anyone" && { answers: "anyone" }),
    },
  }),
});

/** The backup's time where the setup gives none. */
export const NIGHTLY = "0 2 * * *";

/** Where a coworker's own files are, inside its container. */
export const HOME = "/duck/home";
/** Where the files its person sent are, read-only, inside its container. */
export const FILES = "/duck/files";
/** Where the version history of its standing words, notes and voice is, read-only, inside its container. */
export const HISTORY = "/duck/history";

/**
 * Where duck reads the file coworker `coworker` names at `path` in its container: one of its own files or of
 * those its person sent, and not a link out of them; undefined where nothing is there; or else null.
 */
export function fileOf(setup: Setup, coworker: string, path: string) {
  const at = posix.resolve(HOME, path);
  const [inside, folder] = at.startsWith(`${FILES}/`) ? [FILES, "files"] : [HOME, "home"];
  if (!at.startsWith(`${inside}/`)) return null;
  try {
    const root = realpathSync(join(setup.storage.folder, coworker, folder));
    const real = realpathSync(join(root, at.slice(inside.length)));
    return real.startsWith(`${root}/`) && statSync(real).isFile() ? real : null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
}

/** duck's dreaming text, inside the coworker's container (SPEC part 8). */
export const DREAMING = "/duck/goose/config/dreaming.md";

/** The container a coworker's goose runs in, or with no coworker, the firm's duck. */
export const container = (firm: string, coworker?: string) =>
  coworker === undefined ? `duck-${firm}` : `duck-${firm}-${coworker}`;

/** Where a coworker's container reaches the firm's duck: its model relay and its gate. */
export const duckAddress = (setup: Setup) => `http://${container(setup.firm)}:${setup.listen.split(":")[1]}`;

/** Plug setup `text` as coworker `coworker` sends it: `{person}` is its person's handle, or `handle`. */
export const personal = (
  setup: Setup,
  coworker: string,
  text: string,
  handle = factsOf(setup, coworker).handle ?? "",
) => text.replaceAll("{person}", handle);

/** The secrets the plugs given to coworker `coworker` call with, as its person's, or the person `handle` names. */
export const plugKeys = (setup: Setup, coworker: string, handle?: string) =>
  Object.values(setup.plugs ?? {})
    .filter((p) => gives(p, coworker))
    .flatMap((p) => [p.address, ...Object.values(p.headers ?? {})])
    .flatMap((text) =>
      [...personal(setup, coworker, text, handle).matchAll(/\$\{(\w+)\}/g)].map((m) => m[1] ?? ""),
    );

/** Milliseconds in a duration as setup writes it: a number, then s, m or h. */
export function ms(duration: string): number {
  const found = /^(\d+(?:\.\d+)?)([smh])$/.exec(duration);
  if (!found) throw new Error(`"${duration}" is not a duration such as 30s, 10m or 2h`);
  return Number(found[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[found[2] as "s" | "m" | "h"];
}

const stored = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n") : []);

/**
 * The value of secret `name` in the firm's secret store, or with `coworker`, in the keys duck made for it,
 * read at each use so a changed key is seen.
 */
export function secret(setup: Setup, name: string, coworker?: string): string {
  const file = coworker === undefined ? setup.secrets.file : keysFile(setup, coworker);
  const line = stored(file).find((l) => l.startsWith(`${name}=`));
  if (line === undefined) throw new Error(`${coworker ?? "the secret store"} has no ${name}`);
  return line.slice(name.length + 1);
}

/** Those of secrets `names` the firm's secret store lacks, each once. */
export function lacking(setup: Setup, names: string[]) {
  const lines = stored(setup.secrets.file);
  return [...new Set(names)].filter((name) => !lines.some((l) => l.startsWith(`${name}=`)));
}

/** A claimed coworker's owner, its person in Buzz: the key its NIP-OA auth tag names. */
export const ownerOf = (setup: Setup, coworker: string): string =>
  JSON.parse(factsOf(setup, coworker).owner ?? "[]")[1];

/** What is wrong with the setup in `folder`, one line per problem. */
export function check(folder: string): string[] {
  const setup = readSetup(folder);
  if ("people" in setup || "coworkers" in setup)
    return [
      "duck.yaml lists people or coworkers, which duck keeps itself: take them out, make each coworker with duck make and claim it with duck claim",
    ];
  const problems: string[] = [];
  if (setup.jobs && "cost" in setup.jobs)
    problems.push(
      "jobs.cost is gone: a job's run is cut off by its model calls only, jobs.calls; take it out",
    );
  const doors = Object.entries(setup.doors ?? {});
  const named = [
    ...(setup.model.key ? [setup.model.key] : []),
    ...(setup.sorter.key ? [setup.sorter.key] : []),
    ...[setup.backup?.key, setup.backup?.secret, setup.backup?.password].filter((name) => name !== undefined),
    ...doors.flatMap(([, d]) =>
      Object.values(d).flatMap((d) => [d.key, d.auth].filter((n) => n !== undefined)),
    ),
    ...claimed(setup).flatMap((c) => plugKeys(setup, c)),
    ...Object.values(setup.plugs ?? {}).flatMap((p) => (p.events?.push ? [p.events.push] : [])),
  ];
  for (const name of lacking(setup, named))
    problems.push(`the secret store ${setup.secrets.file} has no ${name}`);
  for (const part of ["bucket", "endpoint", "key", "secret", "password"] as const)
    if (!setup.backup?.[part])
      problems.push(
        `backup names no ${part}: coworkers are copied to its bucket, encrypted with its password`,
      );
  try {
    const next = Bun.cron.parse(setup.backup?.at ?? NIGHTLY, Date.now(), { tz: setup.zone });
    if (!next) throw new Error("it never comes");
  } catch (error) {
    problems.push(`backup.at: ${(error as Error).message}`);
  }
  const user = userInfo().username;
  const linger = Bun.spawnSync(["loginctl", "show-user", user, "--property", "Linger", "--value"]);
  if (linger.stdout.toString().trim() !== "yes")
    problems.push(
      `lingering is off for ${user}, so the firm's containers do not start after a reboot; turn it on with loginctl enable-linger ${user}`,
    );
  if (!existsSync(setup.sign)) problems.push(`the sign ${setup.sign} does not exist`);
  if (!existsSync(setup.sorter.file)) problems.push(`the sorter's file ${setup.sorter.file} does not exist`);
  else
    try {
      questions(setup.sorter.file);
    } catch (error) {
      problems.push((error as Error).message);
    }
  for (const part of ["address", "key", "model"] as const)
    if (setup.sorter.mode !== "off" && !setup.sorter[part])
      problems.push(
        `sorter names no ${part}: the route to its decision model, which mode ${setup.sorter.mode} calls`,
      );
  if (!SORTER_MODES.includes(setup.sorter.mode))
    problems.push(`sorter.mode is "${setup.sorter.mode}"; it is one of: ${SORTER_MODES.join(", ")}`);
  if (!(setup.model.route in routes))
    problems.push(`model route "${setup.model.route}" is not one of: ${Object.keys(routes).join(", ")}`);
  if (setup.model.route === "claude-login") problems.push(...loginProblems(setup.model.login));
  if (!zoneOf(setup.zone ?? ""))
    problems.push(`zone is "${setup.zone ?? ""}"; it is the firm's time zone, such as America/Chicago`);
  if (!/^\d\d:\d\d$/.test(setup.settings?.quiet?.[0] ?? "") || !/^\d\d:\d\d$/.test(setup.settings.quiet[1]))
    problems.push("settings.quiet is the firm's default quiet hours: two times such as 21:00 and 07:00");
  for (const name of setup.settings?.locked ?? [])
    if (!(SETTINGS as readonly string[]).includes(name))
      problems.push(`settings.locked names ${name}; a firm locks ${SETTINGS.join(", ")}`);
  if (![undefined, "person", "anyone"].includes(setup.settings?.answers))
    problems.push(`settings.answers is "${setup.settings.answers}"; a coworker answers its person or anyone`);
  if (setup.buzz && !/^wss?:\/\//.test(setup.buzz.relay))
    problems.push(
      `buzz.relay is "${setup.buzz.relay}"; it is the firm's relay, at a ws:// or wss:// address`,
    );
  for (const [command, state] of Object.entries(setup.buzz?.tools ?? {}))
    if (!TOOL_STATES.includes(state))
      problems.push(`buzz's command ${command} is "${state}"; a tool is one of: ${TOOL_STATES.join(", ")}`);
  const coworkers = made(setup);
  const unmade = (where: string, coworker: string) =>
    !coworkers.includes(coworker) &&
    problems.push(`${where} names coworker ${coworker}, which duck has not made; make it with duck make`);
  for (const [name, own] of doors) {
    unmade("doors", name);
    for (const [door, d] of Object.entries(own)) {
      const parts =
        d.kind === "telegram" ? (["address", "key", "auth"] as const) : (["model", "voice", "key"] as const);
      const lacks = parts
        .filter((part) => !d[part])
        .join(", ")
        .replace(/, (?=[^,]*$)/, " or ");
      if (d.kind === "voice" && lacks)
        problems.push(
          `door ${name}.${door} names no ${lacks}: a voice door names its speech model's address, its model and voice, and the secret of its key`,
        );
      else if (d.kind === "telegram" && lacks)
        problems.push(
          `door ${name}.${door} names no ${lacks}: a telegram door names the Bot API's address, the secret of its bot's token and the secret of its person's Telegram user id`,
        );
      else if (d.kind === "voice" && !setup.buzz)
        problems.push(`door ${name}.${door} is a call in Buzz, and the setup has no Buzz relay`);
      else if (
        !(
          d.kind === "http" ||
          d.kind === "voice" ||
          d.kind === "telegram" ||
          (d.kind === "text" && !!d.auth && !!d.line) ||
          (d.kind === "email" && !!d.auth && !!d.mailbox)
        )
      )
        problems.push(
          `door ${name}.${door} is of kind "${d.kind}"; the setup gives http, text with a line and an auth, email with a mailbox and an auth, voice with a model, a voice and a key, and telegram with a key and an auth, and duck makes each coworker's buzz door`,
        );
    }
  }
  for (const [name, plug] of Object.entries(setup.plugs ?? {})) {
    if (Array.isArray(plug.coworkers))
      for (const coworker of plug.coworkers) unmade(`plug ${name}`, coworker);
    else if (plug.coworkers !== "everyone")
      problems.push(`plug ${name}'s coworkers is everyone or a list of coworkers' names`);
    for (const field of ["tools", "others"] as const)
      for (const [tool, state] of Object.entries(plug[field] ?? {}))
        if (!TOOL_STATES.includes(state))
          problems.push(
            `plug ${name}'s tool ${tool} is "${state}"${field === "others" ? " in others" : ""}; a tool is one of: ${TOOL_STATES.join(", ")}`,
          );
    for (const [tool, made] of Object.entries(plug.makes ?? {}))
      for (const kind of [made.kind, made.about?.kind])
        if (kind !== undefined && !KINDS.includes(kind))
          problems.push(`plug ${name}'s tool ${tool} makes a ${kind}; a link is one of: ${KINDS.join(", ")}`);
    for (const box of plug.boxes ?? [])
      if (!existsSync(box)) problems.push(`plug ${name}'s box ${box} does not exist`);
    const polled = plug.events?.poll?.tool;
    if (polled && (plug.tools?.[polled] || plug.others?.[polled]))
      problems.push(
        `plug ${name}'s tool ${polled} is the one duck polls, which no coworker is offered whatever its state; take it out of tools and others`,
      );
  }
  const durations = [
    ["compaction.idle", setup.compaction.idle],
    ["sorter.gap", setup.sorter.gap],
    ["timers.every", setup.timers.every],
    ["settings.one_message_per", setup.settings?.one_message_per],
    ...Object.entries(setup.plugs ?? {}).map(([name, p]) => [
      `plugs.${name}.events.poll.every`,
      p.events?.poll?.every,
    ]),
  ].filter(([, d]) => d !== undefined) as [string, string][];
  for (const [where, duration] of durations)
    try {
      ms(duration);
    } catch (error) {
      problems.push(`${where}: ${(error as Error).message}`);
    }
  return problems;
}

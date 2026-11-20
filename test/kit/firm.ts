import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNITS, unit } from "../../src/setup/install";
import { type Bucket, startBucket } from "./bucket";
import { authTag, type BuzzForFirm } from "./buzz";
import { HARBOR, harbor } from "./duck";
import type { EmailService } from "./email";
import { scriptedModel } from "./model";
import { startPerson } from "./person";
import { listTool, type Plug, type PlugEvent, type PlugTool, startPlug } from "./plug";
import { bothReach, FROM_CONTAINERS, freePort, type Reach, Trouble } from "./reach";
import type { TextLine } from "./text";

const ROOT = join(import.meta.dir, "..", "..");

/** The times a test sets in harbor's setup, written as the setup writes durations: a number, then s, m or h. */
export type Times = {
  /** The sorter's gap (SPEC part 4). */
  gap: string;
  /** How often the scheduler looks at the timers (SPEC part 3). */
  timers: string;
  /** The person's limit on non-urgent messages (SPEC part 10). */
  onePer: string;
  /** How often duck calls the list tool of harbor's calendar, a source that cannot push (SPEC part 1). */
  poll: string;
};

const DEFAULTS: Times = {
  gap: "1s",
  timers: "1s",
  onePer: "1h",
  poll: "1s",
};

const mailInput = {
  type: "object",
  properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
  required: ["to", "subject", "body"],
};

/** A tool's input that takes a file's bytes, as its plug declares it in JSON Schema (SPEC part 9). */
const takesFile = (other: string) => ({
  type: "object",
  properties: {
    [other]: { type: "string" },
    file: { type: "string", contentEncoding: "base64", contentMediaType: "text/plain" },
  },
  required: [other, "file"],
});

/** harbor's mail plug's tools. Their states are harbor's setup's. */
const MAIL_TOOLS: Record<string, PlugTool> = {
  find_mail: { description: "Finds mail in Rosa's mailbox.", answer: () => [] },
  save_draft: {
    description: "Saves a draft in Rosa's Drafts.",
    input: mailInput,
    answer: () => ({ draft: "d-1", thread: "thread-d-1" }),
  },
  send_mail: {
    description: "Sends a mail from Rosa's mailbox.",
    input: mailInput,
    answer: () => ({ sent: "s-1" }),
  },
  delete_mail: { description: "Deletes a mail.", answer: () => "deleted" },
  get_attachments: { description: "Gets a mail's attachments.", answer: () => [] },
  send_file: { description: "Sends a file to someone.", input: takesFile("to"), answer: () => "sent as s-1" },
  store_file: {
    description: "Stores a file in the shared drive.",
    input: takesFile("name"),
    answer: () => "stored",
  },
};

/** The most model calls of a job's run in a test's firm: a few, so a test reaches it (SPEC part 6). */
export const JOB_CALLS = 4;

/** The second person and their coworker a test's firm can have, beside harbor's own. */
export const second = { person: "theo", name: "Theo Grant", coworker: "finch" };

/** The parts of harbor's setup the kit points at itself. */
type Setup = {
  firm: string;
  zone: string;
  listen: string;
  storage: { folder: string };
  secrets: { file: string };
  backup: { bucket: string; endpoint: string; at: string };
  model: { route: string; address: string; login?: string };
  sign: string;
  sorter: { file: string; mode: string; gap: string; address?: string; key?: string; model?: string };
  timers: { every: string; dreaming: string };
  compaction: { idle: string };
  jobs: { calls: number };
  settings: { quiet: string[]; one_message_per: string; answers?: string };
  buzz?: { relay: string; owner?: string };
  doors: Record<string, Record<string, object>>;
  plugs: Record<
    string,
    {
      address: string;
      coworkers: string[] | "everyone";
      tools?: Record<string, string>;
      others?: Record<string, string>;
      events?: { poll?: { every: string } };
      boxes?: string[];
    }
  >;
};

/** `HH:MM` in `zone`, `hours` from now. */
export function clock(zone: string, hours: number) {
  const at = new Date(Date.now() + hours * 3600_000);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(at);
}

/** The `duck` command as package.json's `bin` names it. */
async function duckCommand() {
  const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as { bin: { duck: string } };
  return join(ROOT, pkg.bin.duck);
}

/** Runs `program` and returns what it printed; a machine without it has nothing of the firm's to list. */
async function exec(program: string, ...args: string[]) {
  if (!Bun.which(program)) return "";
  const child = Bun.spawn([program, ...args], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(child.stdout).text();
  await child.exited;
  return out;
}
const podman = (...args: string[]) => exec("podman", ...args);

/**
 * Writes harbor's setup into `folder` as `duck install` reads it: its duck.yaml with the kit's addresses,
 * ports, folders and times, its sign and sorter's file, and its secret store, a file only its owner reads.
 */
async function writeSetup(
  folder: string,
  given: {
    name: string;
    port: number;
    storage: string;
    times: Times;
    secrets: Record<string, string>;
    /** The stand-in model's address. It also serves the sorter's decisions API, at /decisions. */
    model: string;
    login?: string;
    mail: string;
    calendar: string;
    bucket: Pick<Bucket, "name" | "url">;
    /** When the backup runs, as a cron expression in the firm's zone, where it is not the kit's. */
    backup?: string;
    door: (door: string) => string;
    /** The firm's Buzz relay, where the coworker has a buzz door beside harbor's own doors. */
    buzz?: string;
    /** Whom the coworker answers in Buzz beyond its owner, where it says. */
    answers?: string;
    /** A text door the coworker gets beside harbor's own. */
    text?: TextLine["door"];
    /** An email door the coworker gets beside harbor's own. */
    email?: EmailService["door"];
    /** The sorter's mode, where it is not harbor's. */
    sorter?: string;
    /**
     * Where the second person takes what their coworker delivers at its one door, desk. Given, the firm has
     * the second person, whose coworker is given harbor's mail plug.
     */
    second?: (door: string) => string;
    /** Whether harbor's mail plug signs what it pushes, with signed-mail.ts among its boxes. */
    signed?: boolean;
    /** The mail plug's tools' states in a run that answers someone other than the person, where it has any. */
    others?: Record<string, string>;
    /** Whether harbor's calendar answers its list inside a wrapper, with calendar-value.ts as its box. */
    wrapped?: boolean;
  },
) {
  const setup = Bun.YAML.parse(await Bun.file(join(HARBOR, "duck.yaml")).text()) as Setup;
  const { times, settings } = { ...given, settings: setup.settings };
  setup.firm = given.name;
  setup.listen = `127.0.0.1:${given.port}`;
  setup.storage.folder = given.storage;
  setup.secrets.file = join(folder, "secrets.env");
  setup.model.address = given.model;
  if (given.login) {
    setup.model.route = "claude-login";
    setup.model.login = given.login;
  }
  setup.sorter.gap = times.gap;
  setup.sorter.address = `${given.model}/decisions`;
  setup.sorter.mode = given.sorter ?? setup.sorter.mode;
  setup.timers.every = times.timers;
  setup.jobs.calls = JOB_CALLS;
  // Dreaming's nightly timer never comes due while a test runs.
  const [hour, minute] = clock(setup.zone, 12).split(":").map(Number);
  setup.timers.dreaming = `${minute} ${hour} * * *`;
  const at = given.backup ?? setup.timers.dreaming;
  Object.assign(setup.backup, { bucket: given.bucket.name, endpoint: given.bucket.url, at });
  settings.one_message_per = times.onePer;
  settings.quiet = [6, 7].map((h) => clock(setup.zone, h));
  if (given.answers) settings.answers = given.answers;
  // Only a test with a Buzz relay of its own gives the coworker a buzz door.
  if (given.buzz) setup.buzz = { relay: given.buzz };
  else delete setup.buzz;
  const doors = setup.doors[harbor.coworker] as Setup["doors"][string];
  for (const door of harbor.doors) (doors[door] as { address: string }).address = given.door(door);
  if (given.text) doors.text = given.text;
  if (given.email) doors.email = given.email;
  const mail = setup.plugs.mail as Setup["plugs"][string];
  mail.address = given.mail;
  if (given.second)
    setup.doors[second.coworker] = { desk: { ...(doors.desk as object), address: given.second("desk") } };
  if (given.signed) mail.boxes = [...(mail.boxes ?? []), "signed-mail.ts"];
  mail.tools = { ...mail.tools, send_file: "ask first" };
  if (given.others) mail.others = given.others;
  const calendar = setup.plugs.calendar as Setup["plugs"][string] & { events: { poll: { every: string } } };
  calendar.address = given.calendar;
  calendar.events.poll.every = times.poll;
  if (given.wrapped) calendar.boxes = ["calendar-value.ts"];
  writeFileSync(join(folder, "duck.yaml"), Bun.YAML.stringify(setup, null, 2));
  const boxes = Object.values(setup.plugs).flatMap((p) => p.boxes ?? []);
  for (const file of [setup.sign, setup.sorter.file, ...boxes])
    copyFileSync(join(HARBOR, file), join(folder, file));
  const lines = Object.entries(given.secrets).map(([key, value]) => `${key}=${value}\n`);
  writeFileSync(setup.secrets.file, lines.join(""), { mode: 0o600 });
}

/**
 * Writes harbor's setup into a fresh folder with every address pointing at the kit, makes harbor's coworker
 * there with `duck make`, runs `duck check`, and claims it for its person with `duck claim`, which installs,
 * and returns handles on the running firm and on the kit. The firm gets a name of its own, and the
 * containers, networks and volumes duck labels `duck.firm=<name>` are the only ones the kit stops, kills or
 * removes. `reach` says where the kit listens and how duck's containers reach it. With `login`, the firm
 * reaches a real model on the claude-login route, through the Claude login in that folder. With `buzz`, the
 * firm has that Buzz relay, duck's own identity there is authorized by the relay's owner where duck check names
 * its key, the coworker is claimed with the tag of the person there and has a door named buzz on it, and the
 * person meets it there; with `text` the coworker has a door named text on
 * that line, and with `email` a door named email at that mail service. With `mail`, those of the mail plug's tools answer as the test declares them. With `sorter`, the
 * sorter runs in that mode. With `second`, the firm has a second person and coworker, at a desk door of its
 * own, and with `signed`, the mail plug signs its pushes. With `answers`, the
 * buzz door answers whom it names beyond its owner, and with `others`, the mail plug's tools have those states
 * in a run that answers someone other than the person. With `wrapped`, the
 * calendar answers its list inside a wrapper and its box takes the rows out. The firm's storage bucket is the kit's, and with `backup`,
 * the nightly backup runs on that cron expression in the firm's zone; otherwise it never comes due while a
 * test runs.
 */
export async function startFirm(
  given: Partial<Times> & {
    reach?: Reach;
    login?: string;
    buzz?: BuzzForFirm;
    answers?: string;
    text?: TextLine;
    email?: EmailService;
    mail?: Record<string, PlugTool>;
    sorter?: string;
    second?: boolean;
    signed?: boolean;
    others?: Record<string, string>;
    wrapped?: boolean;
    backup?: string;
  } = {},
) {
  const times = { ...DEFAULTS, ...given };
  const reach = given.reach ?? FROM_CONTAINERS;
  const trouble = new Trouble();
  const secret = () => randomBytes(18).toString("base64url");
  /** Each person's key to harbor's mail plug, by the secret's name. */
  const mailKeys: Record<string, string> = Object.fromEntries(
    [harbor.person, second.person].map((p) => [`HARBOR_MAIL_KEY_${p}`, secret()]),
  );
  const secrets = {
    HARBOR_MODEL_KEY: secret(),
    HARBOR_SORTER_KEY: secret(),
    HARBOR_DOOR_KEY: secret(),
    ...mailKeys,
    HARBOR_MAIL_PUSH_KEY: secret(),
    HARBOR_CALENDAR_KEY: secret(),
    HARBOR_BACKUP_KEY: secret(),
    HARBOR_BACKUP_SECRET: secret(),
    HARBOR_BACKUP_PASSWORD: secret(),
    ...given.text?.secrets,
    ...given.email?.secrets,
  };
  const name = `harbor-${randomBytes(3).toString("hex")}`;
  const folder = mkdtempSync(join(tmpdir(), `${name}-`));
  const storage = join(folder, "storage");
  mkdirSync(storage);

  const model = scriptedModel({
    reach,
    key: secrets.HARBOR_MODEL_KEY,
    decisions: secrets.HARBOR_SORTER_KEY,
    trouble,
  });
  const tools = { ...MAIL_TOOLS, ...given.mail };
  const mail = startPlug({ name: "mail", tools, reach, keys: Object.values(mailKeys), trouble });
  /** The rows harbor's calendar lists, as they are at each call; a test adds to them. */
  const rows: Record<string, unknown>[] = [];
  const calendar = startPlug({
    name: "calendar",
    tools: {
      list_events: given.wrapped
        ? { description: "Lists the events on Rosa's calendar.", answer: () => ({ value: rows }) }
        : listTool(rows, "Lists the events on Rosa's calendar."),
      find_events: { description: "Finds events on Rosa's calendar.", answer: () => [] },
    },
    reach,
    keys: [secrets.HARBOR_CALENDAR_KEY],
    trouble,
  });
  const bucket = startBucket({ name: "backup", key: secrets.HARBOR_BACKUP_KEY, reach: bothReach() });
  // Duck has a door's answer to delivery `<coworker>-<message>` once no question the message carries lacks the
  // time its delivery ended (SPEC part 9).
  const heard = (id: string) => {
    const [, coworker = "", message] = /^(.+)-(\d+)$/.exec(id) ?? [];
    const file = join(storage, coworker, "duck.db");
    if (!existsSync(file)) return true;
    const db = new Database(file, { readonly: true });
    try {
      return !db.query("select 1 from outbox where message = ? and sent_at is null").get(Number(message));
    } finally {
      db.close();
    }
  };
  const person = startPerson({ doors: harbor.doors, key: secrets.HARBOR_DOOR_KEY, reach, trouble, heard });
  const theirs = startPerson({ doors: ["desk"], key: secrets.HARBOR_DOOR_KEY, reach, trouble, heard });
  const running = new Set<ReturnType<typeof Bun.spawn>>();
  /** The plugs a test adds to the setup. */
  const added: Plug[] = [];
  /** When the step began, as `podman logs --since` takes it; unset until the first step ends. */
  let since: string | undefined;
  /** Runs systemctl's `verb` on the firm's boot unit, or on `which`, as its user, and returns what it printed. */
  const systemd = async (verb: string, which = unit(name)) =>
    (await exec("systemctl", "--user", verb, which)).trim();
  /**
   * The systemd user units duck install wrote for this firm, by their files' names: the boot unit and any other
   * named after the firm. Path units sort before the services they start, so teardown stops them first.
   */
  const units = () =>
    (existsSync(UNITS) ? readdirSync(UNITS) : [])
      .filter((file) => file === unit(name) || file.startsWith(`duck-firm-${name}-`))
      .sort();

  /** The ids of what duck made for this firm, by its label. */
  const labelled = async (kind: "container" | "network" | "volume") =>
    (
      await podman(
        kind,
        "ls",
        ...(kind === "container" ? ["-a"] : []),
        "-q",
        "--filter",
        `label=duck.firm=${name}`,
      )
    )
      .split("\n")
      .filter(Boolean);
  /** Runs podman's `verb` on each of this firm's `kind`, if it has any. */
  const onEach = async (kind: "container" | "network" | "volume", ...verb: string[]) => {
    const ids = await labelled(kind);
    if (ids.length > 0) await podman(kind, ...verb, ...ids);
  };
  async function teardown() {
    for (const child of running) child.kill("SIGKILL");
    await onEach("container", "rm", "--force", "--time", "0");
    await onEach("network", "rm", "--force");
    await onEach("volume", "rm", "--force");
    const files = units();
    for (const file of files) {
      await systemd("disable", file);
      await systemd("stop", file);
      unlinkSync(join(UNITS, file));
    }
    if (files.length > 0) await exec("systemctl", "--user", "daemon-reload");
    for (const plug of added) plug.stop();
    model.stop();
    mail.stop();
    calendar.stop();
    person.stop();
    theirs.stop();
    bucket.stop();
  }

  try {
    const port = freePort();
    const address = `http://127.0.0.1:${port}`;
    await writeSetup(folder, {
      name,
      port,
      storage,
      times,
      secrets,
      model: model.url,
      login: given.login,
      mail: mail.url,
      calendar: calendar.url,
      bucket,
      backup: given.backup,
      door: person.address,
      buzz: given.buzz?.url,
      answers: given.answers,
      text: given.text?.door,
      email: given.email?.door,
      sorter: given.sorter,
      second: given.second ? theirs.address : undefined,
      signed: given.signed,
      others: given.others,
      wrapped: given.wrapped,
    });

    const duck = await duckCommand();
    /** Runs `duck <command>` in the firm's folder, and returns what it printed and whether it succeeded. */
    const attempt = async (...command: string[]) => {
      const child = Bun.spawn(["bun", duck, ...command], { cwd: folder, stdout: "pipe", stderr: "pipe" });
      running.add(child);
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      running.delete(child);
      return { out, err, code };
    };
    /** Runs `duck <command>` in the firm's folder, and returns what it printed unless it fails. */
    const run = async (...command: string[]) => {
      const { out, err, code } = await attempt(...command);
      if (code !== 0) throw new Error(`duck ${command.join(" ")} exited ${code}:\n${out}${err}`);
      return out;
    };
    /** Changes the setup in the firm's folder; the running system keeps the setup it was installed with. */
    const edit = (change: (setup: Setup) => void) => {
      const path = join(folder, "duck.yaml");
      const setup = Bun.YAML.parse(readFileSync(path, "utf8")) as Setup;
      change(setup);
      writeFileSync(path, Bun.YAML.stringify(setup, null, 2));
    };

    // As an admin's agent does: where duck check names duck's own Buzz key, the relay's owner authorizes it
    // in Buzz and the setup takes her ownership proof, and she adds the key to the member list as an admin.
    const duckKey = given.buzz
      ? /duck's Buzz key is ([0-9a-f]{64})/.exec((await attempt("check")).out)?.[1]
      : undefined;
    if (given.buzz && duckKey) {
      const owner = given.buzz.tagFor(duckKey);
      edit((setup) => {
        if (setup.buzz) setup.buzz.owner = owner;
      });
      await given.buzz.makeAdmin(duckKey);
    }
    /** Makes `coworker` for the person `handle` names, and returns its Buzz key. */
    const make = async (coworker: string, handle: string) =>
      (/its Buzz key is ([0-9a-f]{64})/.exec(await run("make", coworker, handle)) as string[])[1] as string;
    const wren = await make(harbor.coworker, harbor.person);
    const finch = given.second ? await make(second.coworker, second.person) : "";
    await given.buzz?.meet(wren);
    await run("check");
    const someone = (agent: string) => authTag(randomBytes(32), agent);
    if (given.second) await run("claim", second.coworker, someone(finch), second.name);
    await run("claim", harbor.coworker, (given.buzz?.tagFor ?? someone)(wren), harbor.name);
    person.meet(address, harbor.coworker);
    theirs.meet(address, second.coworker);

    const firm = {
      name,
      folder,
      /** duck's own Buzz key, where the firm has Buzz and duck check named it. */
      duckKey,
      /** Runs `duck <command>` in the firm's folder as its admin's agent does, and returns what it printed. */
      duck: run,
      /** The key `person`'s coworker calls harbor's mail plug with. */
      mailKey: (person: string) => mailKeys[`HARBOR_MAIL_KEY_${person}`],
      address,
      model,
      mail,
      calendar: Object.assign(calendar, { rows }),
      person,
      /** The second person's side of their coworker's desk door, where the firm has them. */
      second: theirs,
      bucket,
      trouble,
      /**
       * Ends a step: fails on the first trouble seen, a rule of the model with uses left, or a message a person
       * never read, then forgets the step's rules, requests, calls, holds, answers, refusals and log, so the
       * next step sees only its own.
       */
      async step() {
        try {
          trouble.check();
          model.check();
          person.check();
          theirs.check();
        } finally {
          model.clear();
          for (const plug of [mail, calendar, ...added]) plug.clear();
          person.clear();
          theirs.clear();
          trouble.clear();
          since = new Date().toISOString();
        }
      },
      /** Changes the setup as `change` says and installs it over the running firm with `duck install`, as an admin does. */
      async reinstall(change: (setup: Setup) => void) {
        edit(change);
        await run("install");
      },
      /** Posts `event` to the inbox handler as harbor's mail plug, with its push key or `key`, signed if it signs. */
      push: (
        event: Omit<PlugEvent, "source" | "received_at"> & Partial<PlugEvent>,
        key = secrets.HARBOR_MAIL_PUSH_KEY,
      ) => mail.push(address, key, event, given.signed),
      /** Stops the running system as a server shutdown does. */
      stop: () => onEach("container", "stop", "--time", "10"),
      /** Loads the export of `kind` at `path` into the coworker's archive with `duck import`. */
      import: (kind: string, path: string) => run("import", harbor.coworker, kind, path),
      /** Starts a plug named `plug` with `tools` and gives it to the coworker in the setup, from the next `start`. */
      plugIn(plug: string, tools: Record<string, PlugTool>) {
        const started = startPlug({ name: plug, tools, reach, trouble });
        added.push(started);
        edit((setup) => {
          setup.plugs[plug] = { address: started.url, coworkers: [harbor.coworker] };
        });
        return started;
      },
      /** Runs systemctl's `verb` on the unit `duck install` enabled to start the firm's containers at boot. */
      systemd,
      units,
      /**
       * Where the unit `duck install` wrote to install again after a claim from Buzz stands: its state, and
       * the id systemd gives each of its runs.
       */
      async claimInstall() {
        const shown = await exec(
          "systemctl",
          "--user",
          "show",
          "--property",
          "ActiveState,InvocationID",
          `duck-firm-${name}-install.service`,
        );
        const value = (key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(shown)?.[1] ?? "";
        return { state: value("ActiveState"), run: value("InvocationID") };
      },
      /** Coworker `coworker`'s facts, as duck keeps them in its folder. */
      facts: (coworker: string) =>
        JSON.parse(readFileSync(join(storage, coworker, "coworker.json"), "utf8")) as Record<string, string>,
      /** The secret of the Buzz key duck made for coworker `coworker`, in hex. */
      buzzSecret: (coworker: string) =>
        /^BUZZ_KEY=([0-9a-f]{64})$/m.exec(
          readFileSync(join(storage, coworker, "keys.env"), "utf8"),
        )?.[1] as string,
      /** Changes the setup in the firm's folder; the running system keeps what it was installed with. */
      edit,
      /** Adds secret `name`, with a value made now, to the firm's secret store. */
      addSecret: (name: string) => appendFileSync(join(folder, "secrets.env"), `${name}=${secret()}\n`),
      /** Starts that unit, as systemd does when the server boots, and waits until duck is ready. */
      async boot() {
        await systemd("start");
        const ready = async () => (await fetch(`${address}/ready`).catch(() => null))?.status === 204;
        for (const end = Date.now() + 120_000; !(await ready()); await Bun.sleep(200))
          if (Date.now() > end) throw new Error("duck is not ready 120 s after its unit started");
      },
      /** Copies every coworker to the bucket now, with `duck backup`. */
      backup: () => run("backup"),
      /** Brings the coworker's folder back from the bucket with `duck restore`, from the copy at `time` if given. */
      restore: (time?: string) => run("restore", harbor.coworker, ...(time ? [time] : [])),
      /** Stops the running system and deletes the firm's storage folder, as a lost disk does. */
      async wipe() {
        await firm.stop();
        rmSync(storage, { recursive: true, force: true });
        mkdirSync(storage);
      },
      /** Brings the running system back with `duck install`. */
      start: () => run("install"),
      async restart() {
        await firm.stop();
        await firm.start();
      },
      /** Kills the running system with no warning, as a crash or a power cut does. */
      crash: () => onEach("container", "kill", "--signal", "KILL"),
      /**
       * Kills `coworker`'s goose container with no warning, as goose crashing does. Its restart policy does not
       * bring back a container podman kills, so it stays down until `start`.
       */
      crashGoose: (coworker = harbor.coworker) =>
        podman("kill", "--signal", "KILL", `duck-${name}-${coworker}`),
      /**
       * What the firm's duck container has logged since the step began, as `podman logs` reads it: its standard
       * output, then its standard error.
       */
      async logs() {
        const after = since ? ["--since", since] : [];
        const child = Bun.spawn(["podman", "logs", ...after, `duck-${name}`], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        await child.exited;
        return `${out}\n${err}`;
      },
      /** The JSON lines duck logged since the step began whose first field is `kind`, such as gate or relay. */
      logged: async (kind: string) =>
        (await firm.logs())
          .split("\n")
          .filter((l) => l.startsWith(`{"${kind}"`))
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      /**
       * The container's id for the one process in the firm's duck container whose command is `program`, if one
       * runs. It reads the container's own /proc, since `podman top` needs a cgroup the test queue's containers
       * do not have.
       */
      async pidIn(program: string) {
        const listing = "cd /proc && for p in [0-9]*; do echo \"$p $(tr '\\0' ' ' < $p/cmdline)\"; done";
        const found = (await podman("exec", `duck-${name}`, "sh", "-c", listing))
          .split("\n")
          .map((row) => row.trim().split(/\s+/))
          .filter(([, first]) => first === program);
        if (found.length > 1) throw new Error(`${found.length} ${program} processes run in duck-${name}`);
        return found[0] ? Number(found[0][0]) : undefined;
      },
      /** Ends the process `program` started in the firm's duck container, by its own id, as it ending on its own does. */
      async endIn(program: string) {
        const pid = await firm.pidIn(program);
        if (pid === undefined) throw new Error(`no ${program} runs in duck-${name}`);
        await podman("exec", `duck-${name}`, "sh", "-c", `kill -TERM ${pid}`);
        return pid;
      },
      /** The id of the firm's duck container, or with `coworker`, of that coworker's goose container. */
      duckId: async (coworker?: string) =>
        (
          await podman(
            "inspect",
            "--format",
            "{{.Id}}",
            coworker ? `duck-${name}-${coworker}` : `duck-${name}`,
          )
        ).trim(),
      /** Opens `coworker`'s database file read-only. */
      db: (coworker = harbor.coworker) =>
        new Database(join(storage, coworker, "duck.db"), { readonly: true }),
      [Symbol.asyncDispose]: teardown,
    };
    return firm;
  } catch (error) {
    await teardown();
    throw error;
  }
}

export type Firm = Awaited<ReturnType<typeof startFirm>>;

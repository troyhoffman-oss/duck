import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import pkg from "../../package.json";
import { plugsOf } from "../gate";
import { AT_ONCE } from "../jobs";
import {
  check,
  claimed,
  container,
  DREAMING,
  doorsOf,
  duckAddress,
  FILES,
  HISTORY,
  HOME,
  installFile,
  personOf,
  readSetup,
  type Setup,
} from ".";

const ROOT = join(import.meta.dir, "..", "..");
const CONTAINERFILE = join(import.meta.dir, "Containerfile");
/** Where the firm's Claude login is, inside its duck container. */
export const LOGIN = "/duck/claude-login";
/** Where goose serves ACP inside a coworker's container. */
export const GOOSE_PORT = 3284;

/** What `program` printed, or null when it failed and `may` fail. */
function exec(program: string, args: string[], may = false) {
  const done = Bun.spawnSync([program, ...args], { stdout: "pipe", stderr: "pipe" });
  if (done.exitCode === 0) return done.stdout.toString().trim();
  if (may) return null;
  throw new Error(`${program} ${args.slice(0, 2).join(" ")}: ${done.stderr.toString().trim()}`);
}

const podman = (args: string[], may = false) => exec("podman", args, may);

const words = (text: string) => text.split(" ");

function hash(...parts: (string | Buffer)[]) {
  const h = createHash("sha256");
  for (const part of parts) h.update(part);
  return h.digest("hex").slice(0, 12);
}

/**
 * Builds `target` of duck's Containerfile unless an image of the same inputs exists, and gives its id: the
 * same for every tag podman built the same layers for, so an edit to one stage leaves the other's id be.
 */
function image(target: "duck" | "coworker") {
  const src = [...new Bun.Glob("**").scanSync({ cwd: join(ROOT, "src"), dot: true })];
  const inputs =
    target === "duck"
      ? [join(ROOT, "package.json"), join(ROOT, "bun.lock"), ...src.sort().map((f) => join(ROOT, "src", f))]
      : [CONTAINERFILE];
  const builds = words(
    `GOOSE=${pkg.goose} CLAUDE=${pkg.claude} AGENT_BROWSER=${pkg["agent-browser"]} BUZZ=${pkg.buzz} RESTIC=${pkg.restic}`,
  );
  const tag = hash(...builds, ...inputs.flatMap((f) => [f.slice(ROOT.length), readFileSync(f)]));
  const name = `localhost/duck${target === "duck" ? "" : "-coworker"}:${tag}`;
  if (podman(["image", "exists", name], true) === null)
    podman([
      ...words(`build --target ${target}`),
      ...flag("--build-arg", ...builds),
      ...words(`--tag ${name} -f`),
      CONTAINERFILE,
      ROOT,
    ]);
  return podman(["image", "inspect", "--format", "{{.Id}}", name]) as string;
}

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) writeFileSync(path, text);
}

/**
 * goose's config for coworker `name`: the model through duck's relay, the harness text and the sign, and
 * beside them the dreaming text, for the coworker to read.
 */
function writeGoose(setup: Setup, name: string) {
  const config = join(setup.storage.folder, name, "goose", "config");
  const goose = {
    GOOSE_PROVIDER: "anthropic",
    GOOSE_MODEL: setup.model.coworker,
    ANTHROPIC_HOST: duckAddress(setup),
    GOOSE_MODE: "auto",
    GOOSE_DISABLE_KEYRING: true,
    GOOSE_TELEMETRY_ENABLED: false,
    GOOSE_DISABLE_SESSION_NAMING: true,
    // summon gives goose's `delegate`, a second way to hand off work that a job already is; the extension
    // manager would let the model turn summon back on (crates/goose/src/agents/platform_extensions at 1.59.0).
    extensions: {
      developer: { enabled: true, type: "builtin", name: "developer" },
      summon: { enabled: false },
      extensionmanager: { enabled: false },
    },
  };
  write(join(config, "config.yaml"), Bun.YAML.stringify(goose));
  const text = (file: string) => readFileSync(join(ROOT, "src", "run", file), "utf8");
  // On the claude-login route, `claude` gives the model the login's address.
  const account = setup.model.route === "claude-login" ? `\n${text("account.md").trim()}` : "";
  const person = personOf(setup, name);
  const doors = Object.entries(doorsOf(setup, name)).map(
    ([door, d]) => ({ buzz: "Buzz", text: "text", email: "email", telegram: "Telegram" })[d.kind] ?? door,
  );
  const harness = text("harness.md")
    .replace("{account}", account)
    .replace("{doors}", [doors.slice(0, -1).join(", "), doors.at(-1)].filter(Boolean).join(" and "))
    .replaceAll("{coworker}", name)
    .replaceAll("{person}", person.name)
    .replaceAll("{zone}", person.zone)
    .replaceAll("{firm}", setup.firm)
    .replaceAll("{jobs}", String(AT_ONCE));
  const sign = readFileSync(setup.sign, "utf8");
  write(join(config, "prompts", "system.md"), `${harness}\n{% raw %}\n${sign}\n{% endraw %}\n`);
  write(join(config, "prompts", "compaction.md"), text("compaction.md"));
  write(join(config, basename(DREAMING)), text("dreaming.md"));
  for (const folder of ["home", "files", "history"])
    mkdirSync(join(setup.storage.folder, name, folder), { recursive: true });
}

/**
 * Runs container `name` of firm `firm` from `image` with `flags` and `command`, leaving it be when its
 * duck.spec label holds the digest of each of them and of each of `more` that the setup now asks for.
 * `unhashed` flags are given only to a container made new. Says what it did and, for one made again, why.
 */
function ensure(
  firm: string,
  name: string,
  image: string,
  flags: string[],
  more: Record<string, string>,
  command: string[] = [],
  unhashed: string[] = [],
) {
  const parts = { options: JSON.stringify([flags, command]), image, ...more };
  const want = Object.fromEntries(Object.entries(parts).map(([part, text]) => [part, hash(text)]));
  const label = JSON.stringify(want);
  // Running comes first: it is never empty, so a container with no label still reads as running or not.
  const [running, had = ""] =
    podman(
      ["container", "inspect", "-f", '{{.State.Running}}\t{{index .Config.Labels "duck.spec"}}', name],
      true,
    )?.split("\t") ?? [];
  if (had === label && running === "true") return "kept";
  if (had === label) {
    podman(["start", name]);
    return "started again";
  }
  if (running) podman(["rm", "--force", "--time", "10", name]);
  const run = `run --detach --init --restart always --name ${name} --label duck.firm=${firm}`;
  podman([...words(run), "--label", `duck.spec=${label}`, ...unhashed, ...flags, image, ...command]);
  if (!running) return "started";
  // A label that is not this duck's digests, or none, has no parts, so every part differs.
  const was: Record<string, string> = had.startsWith("{") ? JSON.parse(had) : {};
  return `restarted because its ${Object.keys(want)
    .filter((part) => was[part] !== want[part])
    .join(" and ")} differed`;
}

/** The systemd user unit that starts firm `firm`'s containers at boot, and the folder it is written to. */
export const unit = (firm: string) => `duck-firm-${firm}.service`;
export const UNITS = join(homedir(), ".config", "systemd", "user");

/**
 * Writes and enables the unit that starts the firm's containers when the server boots, since under rootless
 * podman nothing starts a container with a restart policy after a reboot. It is podman-restart.service
 * narrowed to the firm, which starts every container of the user that has a restart policy.
 */
function boot(firm: string) {
  const [podmanAt, mine] = [Bun.which("podman"), `--all --filter label=duck.firm=${firm}`];
  const lines = [
    "[Unit]",
    `Description=duck's firm ${firm}: its containers, started at boot`,
    "Wants=network-online.target",
    "After=network-online.target",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=true",
    `ExecStart=${podmanAt} start ${mine}`,
    `ExecStop=${podmanAt} stop ${mine}`,
    "[Install]",
    "WantedBy=default.target",
  ];
  write(join(UNITS, unit(firm)), `${lines.join("\n")}\n`);
  exec("systemctl", ["--user", "enable", unit(firm)]);
}

/**
 * Where the setup has Buzz, writes and starts the path unit that runs duck install in `folder` when a claim or
 * a stop from there leaves its empty file in storage, since the duck container has no podman; without, takes
 * them away. The service takes the file before it installs, and systemd looks for it again when the service
 * ends, so a claim made during an install gets an install of its own.
 */
function claims(setup: Setup, folder: string) {
  const [path, service] = [`duck-firm-${setup.firm}-install.path`, `duck-firm-${setup.firm}-install.service`];
  const trigger = installFile(setup);
  if (!setup.buzz) {
    if (!existsSync(join(UNITS, path))) return;
    exec("systemctl", ["--user", "disable", "--now", path]);
    for (const file of [path, service]) unlinkSync(join(UNITS, file));
    exec("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  const about = `Description=duck's firm ${setup.firm}: duck install, after a claim from Buzz`;
  const lines = {
    [service]: [
      "[Unit]",
      about,
      "[Service]",
      "Type=oneshot",
      `WorkingDirectory=${folder}`,
      `Environment="PATH=${process.env.PATH}"`,
      // Podman run from a unit keeps each container's conmon in the unit, which stopping kills; without the
      // unit's INVOCATION_ID it gives each its own scope, as from a shell.
      "UnsetEnvironment=INVOCATION_ID",
      `ExecStartPre=${Bun.which("rm")} -f "${trigger}"`,
      `ExecStart="${process.execPath}" "${join(ROOT, "src", "duck.ts")}" install`,
    ],
    [path]: ["[Unit]", about, "[Path]", `PathExists=${trigger}`, "[Install]", "WantedBy=default.target"],
  };
  for (const [file, text] of Object.entries(lines)) write(join(UNITS, file), `${text.join("\n")}\n`);
  exec("systemctl", ["--user", "enable", "--now", path]);
}

/** Each of `values` after flag `name`, as podman takes them. */
const flag = (name: string, ...values: string[]) => values.flatMap((value) => [name, value]);

/** Makes firm `firm`'s bridge network `name` where it is missing, isolated from other bridge networks. */
const bridge = (firm: string, name: string) =>
  podman(["network", "exists", name], true) === null &&
  podman(["network", "create", "--label", `duck.firm=${firm}`, "--opt", "isolate=true", name]);

/** Makes the running system match the setup in `folder` (SPEC part 1). */
export async function install(folder: string) {
  const problems = check(folder);
  if (problems.length > 0) throw new Error(`the setup has problems; run duck check:\n${problems.join("\n")}`);
  const setup = readSetup(folder);
  const [host, port = ""] = setup.listen.split(":");
  const names = claimed(setup);
  const [duck, coworker] = [image("duck"), image("coworker")];
  for (const name of names) {
    writeGoose(setup, name);
    const network = container(setup.firm, name);
    bridge(setup.firm, network);
    const own = join(setup.storage.folder, name);
    const did = ensure(
      setup.firm,
      network,
      coworker,
      [
        ...flag("--network", network),
        // For the image's start-goose to close the private networks; goose never holds it.
        ...flag("--cap-add", "NET_ADMIN"),
        ...flag("--workdir", HOME),
        ...flag("-v", `${own}/home:${HOME}`, `${own}/files:${FILES}:ro`, `${own}/goose:/duck/goose`),
        ...flag("-v", `${own}/goose/config:/duck/goose/config:ro`, `${own}/history:${HISTORY}:ro`),
        ...flag("-e", "GOOSE_PATH_ROOT=/duck/goose", `HOME=${HOME}`, "ANTHROPIC_API_KEY=none"),
        // goose's time block in every turn, and the shell's clock, are in the container's zone.
        ...flag("-e", `TZ=${personOf(setup, name).zone}`),
      ],
      // goose keeps each session's tool list until the gate says it changed, and the gate that could say so
      // is a new process with no stream open to goose, so a coworker whose plugs changed gets a new goose.
      {
        plugs: JSON.stringify(
          plugsOf(setup, name).map(([plug, p]) => [plug, p.address, p.headers, p.tools, p.others]),
        ),
      },
      words(`serve --host 0.0.0.0 --port ${GOOSE_PORT} --dangerously-unauthenticated`),
    );
    console.log(`${name}: ${did}`);
  }
  const [setupFile, duckName] = [join(folder, "duck.yaml"), container(setup.firm)];
  const networks = names.map((name) => container(setup.firm, name));
  // duck is on a bridge network of its own from its first install, so a coworker's network can be connected to
  // it later; with none, rootless podman would give it one that takes no other.
  bridge(setup.firm, duckName);
  const did = ensure(
    setup.firm,
    duckName,
    duck,
    [
      ...flag("--network", duckName),
      ...flag("-p", `${host}:${port}:${port}`),
      ...flag("-v", `${setup.storage.folder}:/duck/storage`, `${folder}:/duck/setup:ro`),
      ...flag("-v", `${setup.secrets.file}:/duck/secrets.env:ro`),
      ...(setup.model.login ? flag("-v", `${setup.model.login}:${LOGIN}`) : []),
      // The log outlives a new container: podman appends to a log file that is already there (measured).
      ...flag("--log-driver", "k8s-file"),
      ...flag("--log-opt", `path=${setup.storage.folder}/duck.log`),
    ],
    // duck reads the setup once, and the gate loads a box once, so a change to either makes a new container.
    {
      setup: [setupFile, ...Object.values(setup.plugs ?? {}).flatMap((p) => p.boxes ?? [])]
        .map((file) => readFileSync(file, "utf8"))
        .join("\n"),
    },
    [],
    // A coworker claimed since is connected to the running duck instead, and duck told (SIGHUP) to start it;
    // a coworker stopped since, to stop it.
    flag("--network", ...networks),
  );
  const on = podman([
    "inspect",
    "--format",
    "{{range $n, $_ := .NetworkSettings.Networks}}{{$n}} {{end}}",
    duckName,
  ]);
  for (const network of networks)
    if (!on?.split(" ").includes(network)) podman(["network", "connect", network, duckName]);
  if (did === "kept") podman(["kill", "--signal", "HUP", duckName]);
  console.log(`duck: ${did}`);
  const wanted = [duckName, ...networks];
  const ours = podman(["ps", "--all", "--filter", `label=duck.firm=${setup.firm}`, "--format", "{{.Names}}"]);
  for (const name of ours?.split("\n") ?? []) if (name && !wanted.includes(name)) podman(["rm", "-f", name]);
  boot(setup.firm);
  // It waits only for the coworkers it installed: one claimed since gets an install of its own.
  const ready = () =>
    fetch(`http://${setup.listen}/ready?${new URLSearchParams({ coworkers: names.join(",") })}`)
      .then((r) => r.ok)
      .catch(() => false);
  for (const end = Date.now() + 120_000; !(await ready()); await Bun.sleep(200))
    if (Date.now() > end)
      throw new Error(`duck is not ready after 120 s; see podman logs ${container(setup.firm)}`);
  claims(setup, folder);
}

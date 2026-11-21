// The setup-from-the-repo test's world (README.md beside this file): an empty server, and outside it the firm's
// throwaway Buzz relay, a stand-in model and a stand-in bucket, up until this process is stopped. The admin's
// hands are requests to HANDS on loopback.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { startBucket } from "../kit/bucket";
import { startBuzz } from "../kit/buzz";
import { harbor } from "../kit/duck";
import { say, scriptedModel } from "../kit/model";
import { loadPlugin } from "../kit/plugin-host";
import { bothReach } from "../kit/reach";

const MACHINE = "duck-clean-machine";
const HANDS = 4799;
const KEYS = join(homedir(), ".duck-clean-machine");

/** What `command` printed, or a throw with its error. */
function run(command: string[], input?: string) {
  const done = Bun.spawnSync(command, {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (done.exitCode !== 0)
    throw new Error(
      `${command.slice(0, 3).join(" ")} exited ${done.exitCode}: ${done.stderr.toString().trim()}`,
    );
  return done.stdout.toString().trim();
}

// Before anything starts, so a second world never touches the first one's machine or relay.
if (Bun.spawnSync(["podman", "container", "exists", MACHINE]).exitCode === 0)
  throw new Error(`${MACHINE} is up already; stop the world that started it`);

const reach = bothReach();
const secret = () => randomBytes(18).toString("base64url");
/** The firm's secrets, by the name the `secret` hand takes; they leave this process only into the machine. */
const secrets: Record<string, string | undefined> = {
  "model-key": secret(),
  "bucket-key": secret(),
  "bucket-secret": secret(),
  "backup-password": secret(),
};
const model = scriptedModel({ reach, key: secrets["model-key"] });
model.on(
  () => true,
  (r) => say(`(the stand-in model) I have your words: ${r.last.slice(-200)}`),
  {
    times: Number.POSITIVE_INFINITY,
  },
);
const bucket = startBucket({ name: "harbor-backup", key: secrets["bucket-key"] as string, reach });
const buzz = await startBuzz({ name: "duck-clean-buzz", reach });

/** The person writes `line` to coworker key `key` in their DM, and gets every answer with the seconds it took. */
async function judge(key: string, line: string) {
  const shown = (await buzz.presence(key)) ?? "not shown";
  const seen = new Set((await buzz.dmOf("rosa", key)).map((m) => m.id));
  const { began } = await buzz.write("rosa", "dm", line, { to: key });
  const said: string[] = [];
  // Up to 300 s for the first answer, then until 20 s pass with nothing more.
  for (let end = Date.now() + 300_000; Date.now() < end; await Bun.sleep(500))
    for (const m of await buzz.dmOf("rosa", key))
      if (!seen.has(m.id)) {
        seen.add(m.id);
        said.push(`${((m.at - began) / 1000).toFixed(1)} s: ${m.content}`);
        end = Date.now() + 20_000;
      }
  if (said.length === 0) throw new Error(`the coworker, ${shown} in Buzz, answered nothing in 300 s`);
  return [`the coworker was ${shown} in Buzz when the person wrote; it answered after`, ...said].join("\n");
}

const hands: Record<string, (words: string[]) => Promise<string>> = {
  /** The community's owner makes Buzz key `key` an admin, as Community admin, Membership, Add directly does. */
  admin: async ([key = ""]) => {
    await buzz.makeAdmin(key);
    return `${harbor.name}, the owner, made ${key} an admin of the community`;
  },
  /** The ownership proof the person copies in Buzz's desktop for coworker key `key`. */
  proof: async ([key = ""]) => buzz.proof("rosa", key),
  /** The person claims coworker `coworker` in New agent with duck's plugin, naming it `name`. */
  claim: async ([coworker = "", ...name]) => {
    const plugin = await loadPlugin(buzz, "rosa");
    return `claimed, key ${(await plugin.add(coworker, name.join(" ") || coworker)).pubkey}`;
  },
  /** The admin adds `NAME=<the secret>` to the secret store file `file` in the machine, which must exist. */
  secret: async ([file = "", name = "", which = ""]) => {
    if (!file || !name || !secrets[which])
      throw new Error(`secret <file in the machine> <NAME> <${Object.keys(secrets).join("|")}>`);
    const append =
      'test -f "$1" || { echo "$1 is not a file" >&2; exit 1; }; [ -s "$1" ] && [ -n "$(tail -c1 "$1")" ] && echo >> "$1"; cat >> "$1"';
    run(["podman", "exec", "-i", MACHINE, "sh", "-c", append, "sh", file], `${name}=${secrets[which]}\n`);
    return `${name} added to ${file}`;
  },
  judge: async ([key = "", ...line]) => judge(key, line.join(" ")),
};

let server: ReturnType<typeof Bun.serve> | undefined;
async function teardown() {
  for (const step of [
    () => run(["podman", "rm", "--force", "--ignore", "--time", "0", MACHINE]),
    () => run(["podman", "volume", "rm", "--force", `${MACHINE}-home`]),
  ])
    try {
      step();
    } catch (error) {
      console.error((error as Error).message);
    }
  await buzz[Symbol.asyncDispose]();
  for (const s of [server, model, bucket]) s?.stop();
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => teardown().then(() => process.exit(0)));

try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: HANDS,
    idleTimeout: 0,
    async fetch(request) {
      const hand = hands[new URL(request.url).pathname.slice(1)];
      if (!hand) return new Response(`the hands are ${Object.keys(hands).join(", ")}\n`, { status: 404 });
      try {
        return new Response(`${await hand((await request.text()).trim().split(/\s+/))}\n`);
      } catch (error) {
        return new Response(`${(error as Error).message}\n`, { status: 500 });
      }
    },
  });
  await buzz.rename("rosa", harbor.name);
  run(["podman", "build", "--tag", MACHINE, import.meta.dir]);
  // Rootless podman inside needs both, each only within this user's own namespace: newuidmap needs
  // CAP_SYS_ADMIN over the namespace it maps, and the kernel refuses a container's new /proc while podman's
  // masked paths cover the machine's.
  run([
    ...["podman", "run", "--detach", "--name", MACHINE, "--hostname", MACHINE, "--systemd=always"],
    ...["--cap-add", "SYS_ADMIN", "--security-opt", "unmask=ALL"],
    ...["--device", "/dev/fuse", "--device", "/dev/net/tun"],
    ...["--volume", `${MACHINE}-home:/home`, "--publish", "127.0.0.1::22", MACHINE],
  ]);
  run(["podman", "exec", MACHINE, "systemctl", "is-system-running", "--wait"]);
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  const id = join(KEYS, "id");
  if (!existsSync(id)) run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", id]);
  const authorize =
    "umask 077 && mkdir -p /home/admin/.ssh && cat > /home/admin/.ssh/authorized_keys && chown -R admin:admin /home/admin/.ssh";
  run(["podman", "exec", "-i", MACHINE, "sh", "-c", authorize], await Bun.file(`${id}.pub`).text());
  const [host, port] = run(["podman", "port", MACHINE, "22"]).split(":");
  console.log(`the empty server: ssh -i ${id} -p ${port} admin@${host}, from this host; admin has sudo
the firm's Buzz relay: ${buzz.url}; ${harbor.name} owns the community and is the first coworker's person
the model: the Messages API at ${model.url}, any model name, its key the secret model-key
the bucket: ${bucket.name} at ${bucket.url}, its access key bucket-key and secret bucket-secret; the backup's password backup-password
the hands: curl --fail-with-body -sS http://127.0.0.1:${HANDS}/<${Object.keys(hands).join("|")}> --data-binary '<words>'`);
} catch (error) {
  console.error((error as Error).message);
  await teardown();
  process.exit(1);
}

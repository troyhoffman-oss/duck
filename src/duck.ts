#!/usr/bin/env bun
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import { importHistory, importMaterial } from "./archive/history";
import { coworkersChanged, listChanged, member, personFor, publish, talk } from "./dms";
import { face, quiet, take } from "./doors";
import { gate } from "./gate";
import { add, openDb, type Pushed, poll, push } from "./inbox";
import { modelRelay } from "./model-relay";
import { type Coworker, startCoworker } from "./run";
import { check, claimed, container, factsOf, gives, made, NIGHTLY, personOf, readSetup } from "./setup";
import { backup, restore } from "./setup/backup";
import { claim, identityToDo, make } from "./setup/coworkers";
import { install, LOGIN } from "./setup/install";
import { DREAM, useTimers } from "./timers";

/** The setup as the firm's duck container holds it. */
function inside() {
  const setup = readSetup("/duck/setup");
  setup.storage.folder = "/duck/storage";
  setup.secrets.file = "/duck/secrets.env";
  setup.model.login &&= LOGIN;
  return setup;
}

/** The firm's duck container: its doors, model relay and gate on one port, and a worker per coworker. */
async function serve() {
  const setup = inside();
  const relay = modelRelay(setup);
  const coworkers = new Map<string, Coworker>();
  /** The coworkers whose goose has been up; one that is not holds up none of the others. */
  const up = new Set<string>();
  /**
   * Stops each running coworker no longer claimed, then starts each claimed one not running and publishes its
   * profile and list: every one at start, and those stopped or claimed since when install says (SIGHUP), one
   * install after another, then tells the admins. One that fails to stop or start is logged and holds up none of
   * the others.
   */
  const match = async () => {
    const now = claimed(setup);
    for (const [name, coworker] of coworkers)
      if (!now.includes(name)) {
        coworkers.delete(name);
        up.delete(name);
        await coworker.stop().catch((e: Error) => console.error(`${name} did not stop: ${e.message}`));
      }
    for (const name of now.filter((name) => !coworkers.has(name)))
      try {
        publish(setup, name).catch((e: Error) => console.error(`${name}'s profile: ${e.message}`));
        const coworker = startCoworker(setup, name);
        listChanged(name, coworker.db);
        coworkers.set(name, coworker);
        void coworker.connected.then(() => {
          if (coworkers.get(name) !== coworker) return;
          up.add(name);
          coworkersChanged(coworkers);
        });
      } catch (e) {
        console.error(`${name} did not start: ${(e as Error).message}`);
      }
    coworkersChanged(coworkers);
  };
  let matching = Promise.resolve();
  const changed = () => {
    matching = matching
      .then(match)
      .catch((e: Error) => console.error(`the coworkers duck runs: ${e.message}`));
  };
  process.on("SIGHUP", changed);
  /** The running coworker whose container calls from `ip`, known by its address on the coworker's own network. */
  const caller = async (ip: string) => {
    const running = [...coworkers.values()];
    const addresses = await Promise.all(
      running.map((c) =>
        lookup(container(setup.firm, c.name), { family: 4 }).then(
          (a) => a.address,
          () => "",
        ),
      ),
    );
    return running[addresses.indexOf(ip)];
  };
  /**
   * Writes plug `plug`'s event to the inbox of each of its coworkers, or where it names a person, of that
   * person's, and wakes them. A source may give a ref or what an event is about as a number.
   */
  const arrive = (plug: string, { ref, about, payload, person }: Pushed) => {
    const given = setup.plugs?.[plug];
    const to = [...coworkers.values()].filter(
      (c) =>
        given && gives(given, c.name) && (person === undefined || factsOf(setup, c.name).handle === person),
    );
    if (to.length === 0) console.error(`plug ${plug}'s event ${ref} for ${person} reaches no coworker`);
    const [r, a, p] = [String(ref), about == null ? null : String(about), JSON.stringify(payload ?? null)];
    const added = to.filter((c) => add(c.db, plug, r, p, null, null, a) !== null);
    for (const c of added) c.wake();
    return { reached: to.length, added: added.length };
  };
  Bun.serve({
    hostname: "0.0.0.0",
    port: Number(setup.listen.split(":")[1]),
    // A model's answer, or a plug's, can take minutes.
    idleTimeout: 0,
    async fetch(request, server) {
      const [, part, name = "", door = ""] = new URL(request.url).pathname.split("/");
      if (part === "v1" || part === "mcp") {
        const from = await caller(server.requestIP(request)?.address ?? "");
        if (!from) return new Response("duck answers its coworkers' containers only", { status: 403 });
        return part === "v1" ? relay(request, from.name, from.spent) : gate(from, request);
      }
      if (part === "events") return push(setup, name, request, arrive);
      const coworker = coworkers.get(name);
      if (part === "doors" && coworker) return take(coworker, door, request);
      // Ready once duck runs every coworker claimed now and each one's goose has been up.
      if (part === "ready")
        return new Response(null, { status: claimed(setup).every((n) => up.has(n)) ? 204 : 503 });
      return new Response("not found", { status: 404 });
    },
  });
  changed();
  talk(setup);
  process.once("SIGTERM", () => quiet().then(() => process.exit(143)));
  poll(setup, coworkers, arrive);
  const at = setup.backup.at ?? NIGHTLY;
  const failed = (e: Error) => console.error(`the backup failed; it runs again on "${at}": ${e.message}`);
  Bun.cron(at, () => backup(setup).catch(failed), { tz: setup.zone });
}

const [command] = process.argv.slice(2);
if (command === "check") {
  const problems = check(process.cwd());
  for (const problem of problems) console.log(problem);
  for (const line of identityToDo(readSetup(process.cwd()))) console.log(line);
  console.log(problems.length === 0 ? "the setup is ready to install" : `${problems.length} problems`);
  process.exit(problems.length === 0 ? 0 : 1);
} else if (command === "install") await install(process.cwd());
else if (command === "make") {
  const [coworker = "", handle, named] = process.argv.slice(3);
  const firm = readSetup(process.cwd());
  // The running duck finds the person, and is told (SIGHUP) to offer them the coworker once it is made.
  const person = named === undefined ? undefined : personFor(firm, named);
  const key = make(process.cwd(), coworker, handle, person);
  if (person) Bun.spawnSync(["podman", "kill", "--signal", "HUP", container(firm.firm)]);
  console.log(`duck made coworker ${coworker}; its Buzz key is ${key}`);
} else if (command === "claim") {
  const [coworker = "", tag = "", person = "", handle] = process.argv.slice(3);
  claim(readSetup(process.cwd()), coworker, tag, person, handle);
  await install(process.cwd());
} else if (command === "import") {
  const [coworker = "", kind = "", path = ""] = process.argv.slice(3);
  const setup = readSetup(process.cwd());
  if (!made(setup).includes(coworker)) throw new Error(`duck has not made coworker "${coworker}"`);
  const db = openDb(join(setup.storage.folder, coworker, "duck.db"));
  const loaded = importHistory(db, kind, path);
  const kept = importMaterial(kind, path, join(setup.storage.folder, coworker, "home", "before"));
  for (const line of [...loaded, ...kept]) console.log(line);
  // The coworker dreams over what was loaded at once, not at night (SPEC part 13), once anything was.
  if (kept.length > 0 || db.query<{ n: number }, []>("select total_changes() as n").get()?.n)
    console.log(
      useTimers(db, personOf(setup, coworker).zone, "set_timer", {
        note: DREAM,
        at: new Date().toISOString(),
      }),
    );
} else if (command === "backup") await backup(readSetup(process.cwd()));
else if (command === "restore")
  await restore(readSetup(process.cwd()), process.argv[3] ?? "", process.argv[4]);
else if (command === "serve") await serve();
// Plumbing for duck make, run in the firm's duck container: one key, or one refusal.
else if (command === "member") {
  setTimeout(() => process.exit(1), 30_000);
  const key = await member(inside(), process.argv[3] ?? "").catch((e: Error) => console.error(e.message));
  if (key) console.log(key);
  process.exit(key ? 0 : 1);
} else if (command === "buzz") await face(process.argv[3] ?? "");
else {
  console.log(
    "duck check: says what is wrong with the setup in this folder\nduck install: makes the running system match it\nduck make <coworker> [handle] [member]: makes a coworker, for the person the handle names if given, and prints its Buzz key; with the person's Buzz name or key as member, duck offers it to them in duck's plugin in Buzz\nduck claim <coworker> <tag> <name> [handle]: gives the coworker to the person whose NIP-OA auth tag signs its Buzz key, named <name>, and installs\nduck import <coworker> <kind> <path>: loads a person's history from before into the coworker's archive, and from an earlier agent's folder what it remembered and scheduled into before/ in the coworker's home\nduck backup: copies every coworker's database and stored files to the setup's bucket now\nduck restore <coworker> [time]: brings a coworker's folder back from its newest copy, or the newest whose UTC time starts with [time]; run it with the firm's duck stopped, then duck install",
  );
  process.exit(command === "--help" ? 0 : 2);
}

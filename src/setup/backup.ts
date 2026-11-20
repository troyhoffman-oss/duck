import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { checkName, made, type Setup, secret } from ".";

/**
 * Runs restic on coworker `name`'s repository, `restic/<firm>/<name>/` in the bucket, and gives what it
 * printed; an exit not in `ok` throws. Keys reach restic in its environment, never its arguments. A run that
 * finds the repository locked by another, the nightly copy and `duck backup` at once, waits for it.
 */
async function restic(setup: Setup, name: string, args: string[], cwd?: string, ok = [0]) {
  const { bucket, endpoint, key, secret: id, password } = setup.backup;
  const proc = Bun.spawn(["restic", "--retry-lock=10m", ...args], {
    cwd,
    env: {
      ...process.env,
      RESTIC_REPOSITORY: `s3:${endpoint}/${bucket}/restic/${setup.firm}/${name}`,
      RESTIC_PASSWORD: secret(setup, password),
      AWS_ACCESS_KEY_ID: secret(setup, key),
      AWS_SECRET_ACCESS_KEY: secret(setup, id),
      // Beside the coworkers, so the duck container made anew and `duck backup` on the server share one cache.
      RESTIC_CACHE_DIR: join(setup.storage.folder, ".restic"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (!ok.includes(code)) throw new Error(`restic ${args[0]}: ${err.trim()}`);
  return { out, err, code };
}

/**
 * Copies each coworker's folder into its own restic repository in the bucket, which stores only what changed
 * since the last copy, and keeps the copies of the last 30 days. Each SQLite file in it, its database and
 * goose's, is copied as of one moment with VACUUM INTO into a folder beside it, and the copy is what is stored.
 */
export async function backup(setup: Setup) {
  for (const name of made(setup)) {
    const own = join(setup.storage.folder, name);
    // Named anew each run, so the nightly copy and `duck backup` at once never share one. A run killed midway
    // leaves its folder behind.
    const copies = mkdtempSync(join(setup.storage.folder, `.${name}-`));
    try {
      const dbs: string[] = [];
      for (const file of new Bun.Glob("**").scanSync({ cwd: own, dot: true })) {
        // Closing any descriptor on a file drops every lock this process holds on it through SQLite
        // (sqlite.org/howtocorrupt.html, 2.2), so duck's own database and every -wal, -shm and -journal,
        // none of them a database, are never opened to look. A file gone or unreadable by now is not a
        // database; restic deals with it as it reads the folder.
        if (/-(wal|shm|journal)$/.test(file)) continue;
        if (
          file !== "duck.db" &&
          (await Bun.file(join(own, file))
            .slice(0, 16)
            .text()
            .catch(() => "")) !== "SQLite format 3\0"
        )
          continue;
        mkdirSync(dirname(join(copies, file)), { recursive: true });
        using db = new Database(join(own, file));
        db.run("vacuum into ?", [join(copies, file)]);
        dbs.push(file);
      }
      // Exit 10: no repository yet. A run killed midway leaves its lock, which blocks every later prune, or
      // every run after a prune, until removed; so the config is read with no lock, and unlock removes only
      // stale locks, unrefreshed for 30 minutes or of a process gone on this host.
      const exists =
        (await restic(setup, name, ["cat", "config", "--no-lock"], undefined, [0, 10])).code === 0;
      await restic(setup, name, [exists ? "unlock" : "init"]);
      const skip = dbs.flatMap((f) =>
        ["", "-wal", "-shm", "-journal"].map((e) => `--exclude=${own}/${f}${e}`),
      );
      // Paths relative to the storage folder are stored as they are, so a copy made in the duck container and
      // one made on the server hold the same tree, and `--group-by=` takes the newest copy as the one before.
      // Exit 3 is a copy kept without a file that could not be read, as one gone while restic read the folder.
      const done = await restic(
        setup,
        name,
        ["backup", "--group-by=", ...skip, name, basename(copies)],
        setup.storage.folder,
        [0, 3],
      );
      await restic(setup, name, ["forget", "--group-by=", "--keep-within=30d", "--prune"]);
      const said = `${done.out}${done.code ? done.err : ""}`.trim().replace(/\n+/g, "; ");
      console.log(`${name}: ${said}`);
    } finally {
      rmSync(copies, { recursive: true, force: true });
    }
  }
}

/** Brings coworker `name`'s folder back from its newest copy, or the newest whose UTC time starts with `time`. */
export async function restore(setup: Setup, name: string, time = "") {
  checkName(name);
  const own = join(setup.storage.folder, name);
  if (existsSync(join(own, "duck.db")))
    throw new Error(`${own} already holds a database; restore fills only a folder without one`);
  const listed = JSON.parse((await restic(setup, name, ["snapshots", "--json"])).out) as {
    id: string;
    time: string;
    paths: string[];
  }[];
  const copy = listed
    .map((s) => ({ ...s, time: new Date(s.time).toISOString() }))
    .filter((s) => s.time.startsWith(time))
    .sort((a, b) => a.time.localeCompare(b.time))
    .at(-1);
  if (!copy)
    throw new Error(`restic/${setup.firm}/${name}/ in the bucket has no copy whose time starts "${time}"`);
  // The folder, then its SQLite copies over the files they were made from, which the copy left out.
  for (const path of [name, ...copy.paths.map((p) => basename(p)).filter((p) => p !== name)])
    await restic(setup, name, ["restore", `${copy.id}:${path}`, "--target", own]);
  console.log(`restored ${name}'s copy of ${copy.time} into ${own}; duck install starts it`);
}

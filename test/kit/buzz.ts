import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import pkg from "../../package.json";
import { FROM_CONTAINERS, freePort } from "./reach";

/** Buzz's relay at commit 44e97e9, as duck's buzz-acp and CLI are, and the stores it runs on, each at its multi-platform digest. */
const IMAGES = {
  relay: "ghcr.io/block/buzz@sha256:bf9da37fcd10216fb36543ea7ee450a7c028da9e5a415416748ffdbd6295aa98",
  postgres:
    "docker.io/library/postgres@sha256:d3244e8ce3f165ee3c93d9c4a4b1d0fe48b3a89e2287b717fdcbbde92d405065",
  redis: "docker.io/library/redis@sha256:7f7d30b7fdd09467bac58198a1f166dd69789d348d4fe859cccb20e0cf287fbe",
  s3: "docker.io/pgsty/silo@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46",
  /** The person's Buzz CLI: the image duck takes buzz-acp and the CLI from. */
  cli: `ghcr.io/block/buzz-sprig:${pkg.buzz}`,
};

/** A message in Buzz as the person reads it with Buzz's CLI, and when the kit first saw it. */
export type BuzzMessage = { id: string; pubkey: string; content: string; tags: string[][]; at: number };
/** An event as the relay sends it (NIP-01). */
export type BuzzEvent = Omit<BuzzMessage, "at"> & { kind: number; created_at: number; sig: string };

/** What podman printed, or a throw with its error. */
async function podman(args: string[], input?: string) {
  const child = Bun.spawn(["podman", ...args], {
    stdin: input === undefined ? "ignore" : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`podman ${args.slice(0, 3).join(" ")} exited ${code}: ${err.trim()}`);
  return Buffer.from(out);
}

/** Tries `step` every 250 ms for up to `seconds`, until it does not throw. */
async function settled<T>(what: string, step: () => Promise<T>, seconds = 60): Promise<T> {
  for (const end = Date.now() + seconds * 1000; ; await Bun.sleep(250)) {
    try {
      return await step();
    } catch (error) {
      if (Date.now() > end) throw new Error(`waited ${seconds} s for ${what}: ${(error as Error).message}`);
    }
  }
}

/** The public key of secret key `key`, in hex. */
const pub = (key: Uint8Array) => Buffer.from(schnorr.getPublicKey(key)).toString("hex");

/** Event `kind` with `tags` and `content`, signed with secret key `key` (NIP-01). */
function signed(key: Uint8Array, kind: number, tags: string[][], content: string) {
  const [pubkey, created_at] = [pub(key), Math.floor(Date.now() / 1000)];
  const id = createHash("sha256")
    .update(JSON.stringify([0, pubkey, created_at, kind, tags, content]))
    .digest();
  const sig = Buffer.from(schnorr.sign(id, key)).toString("hex");
  return { id: id.toString("hex"), pubkey, created_at, kind, tags, content, sig };
}

/**
 * The NIP-OA tag from the owner of secret key `owner` for `agent`: the owner signs
 * sha256("nostr:agent-auth:<agent>:<conditions>"), as buzz-sdk's nip_oa.rs checks.
 */
export function authTag(owner: Uint8Array, agent: string) {
  const signed = schnorr.sign(createHash("sha256").update(`nostr:agent-auth:${agent}:`).digest(), owner);
  return JSON.stringify(["auth", pub(owner), "", Buffer.from(signed).toString("hex")]);
}

/**
 * What a firm needs of a test's Buzz: the relay's address, the person's tag for the coworker's key, which
 * `duck claim` takes, and once the coworker is made, a way to meet it there.
 */
export type BuzzForFirm = {
  url: string;
  tagFor: (agent: string) => string;
  meet: (agent: string) => Promise<void>;
};

/**
 * Who writes in a test's Buzz: harbor's person, Theo and Ana, people at the firm, and Heron, another agent she
 * owns.
 */
export type Writer = "rosa" | "theo" | "ana" | "heron";

/**
 * A throwaway Buzz relay for one test, rootless, with its database, cache and media store, and on it, with
 * keys made now: harbor's person, who owns the relay and whose tag claims the coworker as its person's does;
 * Theo and Ana; and Heron, an agent she owns as she owns the coworker, with a profile that says so as Buzz's own
 * agents' do. Once duck has made the coworker, `meet` has the four share a channel, harbor-ops, and the person
 * open a DM with it. The relay is published on a free port under the address duck's containers reach it at,
 * and each writer's Buzz CLI runs in a container so it reaches the relay at that same address. Everything
 * carries the label duck.kit=<name>, which duck's install never touches, and goes when the test ends, passed
 * or failed.
 */
export async function startBuzz() {
  const name = `duck-kit-${randomBytes(3).toString("hex")}`;
  const folder = mkdtempSync(join(tmpdir(), `${name}-`));
  mkdirSync(join(folder, "files"));
  const port = freePort();
  const url = `ws://${FROM_CONTAINERS.host}:${port}`;
  const hex = () => randomBytes(32).toString("hex");
  const secrets = {
    rosa: randomBytes(32),
    theo: randomBytes(32),
    ana: randomBytes(32),
    heron: randomBytes(32),
  };
  /** Each writer's public key, and the coworker's once duck has made it. */
  const keys = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, pub(v)])) as Record<
    keyof typeof secrets | "wren",
    string
  >;
  const authFor = (agent: string) => authTag(secrets.rosa, agent);
  const [db, s3] = [hex(), { user: hex().slice(0, 20), password: hex() }];
  const at = (role: string) => `${name}-${role}`;
  /** A file of `vars` only this user reads, for podman's --env-file, so no secret is on a command line. */
  const env = (role: string, vars: Record<string, string>) => {
    const path = join(folder, `${role}.env`);
    writeFileSync(
      path,
      Object.entries(vars)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
      { mode: 0o600 },
    );
    return ["--env-file", path];
  };
  const run = (role: string, ...args: string[]) =>
    podman(["run", "--detach", "--name", at(role), "--label", `duck.kit=${name}`, ...args]);
  const cli = (args: string[], input?: string, who: Writer = "rosa") =>
    podman(["exec", "-i", at(who), "buzz", ...args], input);

  async function teardown() {
    const ids = (await podman(["ps", "-aq", "--filter", `label=duck.kit=${name}`])).toString().split("\n");
    if (ids.some(Boolean))
      await podman(["rm", "--force", "--volumes", "--time", "0", ...ids.filter(Boolean)]);
    await podman(["network", "rm", "--force", name]).catch(() => undefined);
  }

  try {
    const started = performance.now();
    await podman(["network", "create", "--label", `duck.kit=${name}`, name]);
    const net = ["--network", name];
    await run(
      "postgres",
      ...net,
      ...env("postgres", { POSTGRES_USER: "buzz", POSTGRES_PASSWORD: db }),
      IMAGES.postgres,
    );
    await run("redis", ...net, IMAGES.redis);
    const root = { MINIO_ROOT_USER: s3.user, MINIO_ROOT_PASSWORD: s3.password };
    await run("s3", ...net, ...env("s3", root), IMAGES.s3, "server", "/data");
    await settled("postgres", () => podman(["exec", at("postgres"), "pg_isready", "-U", "buzz"]));
    await run(
      "relay",
      ...net,
      ...["-p", `${FROM_CONTAINERS.bind}:${port}:3000`],
      ...env("relay", {
        RELAY_URL: url,
        RELAY_OWNER_PUBKEY: keys.rosa,
        BUZZ_BIND_ADDR: "0.0.0.0:3000",
        DATABASE_URL: `postgres://buzz:${db}@${at("postgres")}:5432/buzz`,
        REDIS_URL: `redis://${at("redis")}:6379`,
        BUZZ_REQUIRE_AUTH_TOKEN: "true",
        BUZZ_ALLOW_NIP_OA_AUTH: "true",
        BUZZ_AUTO_MIGRATE: "true",
        BUZZ_GIT_CONFORMANCE_PROBE: "false",
        BUZZ_PUSH_ENABLED: "false",
        BUZZ_RELAY_PRIVATE_KEY: hex(),
        BUZZ_GIT_HOOK_HMAC_SECRET: hex(),
        BUZZ_S3_ENDPOINT: `http://${at("s3")}:9000`,
        BUZZ_S3_ACCESS_KEY: s3.user,
        BUZZ_S3_SECRET_KEY: s3.password,
        BUZZ_S3_ADDRESSING_STYLE: "path",
        BUZZ_MEDIA_BASE_URL: `http://${FROM_CONTAINERS.host}:${port}/media`,
      }),
      IMAGES.relay,
    );
    const mc = env("mc", { MC_HOST_media: `http://${s3.user}:${s3.password}@127.0.0.1:9000` });
    await settled("the media bucket", () =>
      podman(["exec", ...mc, at("s3"), "mc", "mb", "--ignore-existing", "media/buzz-media"]),
    );
    await settled("the relay", async () => {
      if (!(await fetch(`http://127.0.0.1:${port}/health`)).ok) throw new Error("not healthy");
    });
    const writers: Writer[] = ["rosa", "theo", "ana", "heron"];
    await Promise.all(
      writers.map((who) =>
        run(
          who,
          ...env(who, {
            BUZZ_RELAY_URL: url,
            BUZZ_PRIVATE_KEY: secrets[who].toString("hex"),
            ...(who === "heron" ? { BUZZ_AUTH_TAG: authFor(keys.heron) } : {}),
            NO_COLOR: "1",
          }),
          "-v",
          `${join(folder, "files")}:/files:ro`,
          "--entrypoint",
          "sleep",
          IMAGES.cli,
          "infinity",
        ),
      ),
    );
    // Buzz's CLI signs every event with its BUZZ_AUTH_TAG, so Heron's profile carries the person's tag.
    await cli(["users", "set-profile", "--name", "Heron"], undefined, "heron");
    await cli(["users", "set-profile", "--name", "Theo"], undefined, "theo");
    await cli(["users", "set-profile", "--name", "Ana"], undefined, "ana");
    const made = await cli([
      "channels",
      "create",
      "--name",
      "harbor-ops",
      "--type",
      "stream",
      "--visibility",
      "open",
    ]);
    const channel = String(JSON.parse(made.toString()).channel_id);
    for (const who of [keys.theo, keys.heron])
      await cli(["channels", "add-member", "--channel", channel, "--pubkey", who]);
    console.log(
      `kit: the Buzz relay and harbor-ops were up in ${Math.round(performance.now() - started)} ms`,
    );
    /** The status Buzz shows the person for key `agent`: online once its buzz-acp listens. */
    const presence = async (agent: string): Promise<string | undefined> =>
      JSON.parse((await cli(["users", "presence", "--pubkeys", agent])).toString())[0]?.status;
    /** The person's DM with the coworker, once they have met. */
    let dm = "";
    /** Has the person meet coworker `agent`, which duck made: the coworker joins harbor-ops and she opens a DM with it. */
    async function meet(agent: string) {
      keys.wren = agent;
      await cli(["channels", "add-member", "--channel", channel, "--pubkey", agent]);
      dm = String(JSON.parse((await cli(["dms", "open", "--pubkey", agent])).toString()).dm_id);
      dms.set(`rosa ${agent}`, dm);
    }

    const seen = new Map<string, number>();
    const taken = new Set<string>();
    /** The messages of the coworker, or of key `author`, in what `args` of Buzz's CLI list as `who`, oldest first. */
    async function coworkers(
      args: string[],
      who: Writer = "rosa",
      author = keys.wren,
    ): Promise<BuzzMessage[]> {
      const list = JSON.parse((await cli(["messages", ...args, "--limit", "50"], undefined, who)).toString());
      for (const m of list as BuzzMessage[]) if (!seen.has(m.id)) seen.set(m.id, performance.now());
      return (list as BuzzMessage[])
        .filter((m) => m.pubkey === author)
        .map((m) => ({ ...m, at: seen.get(m.id) as number }));
    }
    /** The coworker's messages in the DM, oldest first. */
    const read = () => coworkers(["get", "--channel", dm]);

    /** Each DM a writer is in, by the writer and the key it is with. */
    const dms = new Map<string, string>();
    /** `who`'s DM with key `to`, which Buzz keeps one of per pair: opened by them now if not yet known. */
    async function dmWith(who: Writer, to: string) {
      if (!dms.has(`${who} ${to}`))
        dms.set(
          `${who} ${to}`,
          String(JSON.parse((await cli(["dms", "open", "--pubkey", to], undefined, who)).toString()).dm_id),
        );
      return dms.get(`${who} ${to}`) as string;
    }
    /**
     * `who` writing `text` with `files` at `place`, the DM with the coworker, or with key `to`, or harbor-ops,
     * tagging the coworker, or `to`, with `mention`, as Buzz's desktop does in a DM with an agent (buzz-app
     * src/features/relay/messages.ts:92-106) and in a channel when the writer names it, and with `reply`, in the
     * thread under that event. Returns when the send began and the id of the event written.
     */
    async function write(
      who: Writer,
      place: "dm" | "harbor-ops",
      text: string,
      { files = [] as { name: string; bytes: string }[], mention = true, reply = "", to = keys.wren } = {},
    ) {
      for (const f of files) writeFileSync(join(folder, "files", f.name), f.bytes);
      const where = place === "dm" ? await dmWith(who, to) : channel;
      const began = performance.now();
      const attached = files.flatMap((f) => ["--file", `/files/${f.name}`]);
      const tagged = mention ? ["--mention", to] : [];
      const under = reply ? ["--reply-to", reply] : [];
      const sent = await cli(
        ["messages", "send", "--channel", where, ...under, ...tagged, ...attached, "--content", "-"],
        text,
        who,
      );
      return { began, id: String(JSON.parse(sent.toString()).event_id) };
    }

    /**
     * Subscribes to `filters` as `who`, as Buzz's apps do, on the relay's socket signed in as them (NIP-42),
     * handing `on` each event, and resolves with the socket once the relay has sent what it keeps (EOSE).
     */
    async function subscribe(who: Writer, filters: object[], on: (event: BuzzEvent) => void) {
      const subscribed = Promise.withResolvers<void>();
      // The relay serves only the host its address names.
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { host: new URL(url).host } });
      const send = (...frame: unknown[]) => ws.send(JSON.stringify(frame));
      ws.onmessage = (m) => {
        const [type, a, b] = JSON.parse(String(m.data));
        if (type === "AUTH")
          send(
            "AUTH",
            signed(
              secrets[who],
              22242,
              [
                ["relay", url],
                ["challenge", a],
              ],
              "",
            ),
          );
        else if (type === "OK" && b === true) send("REQ", "kit", ...filters);
        else if (type === "EOSE") subscribed.resolve();
        else if (type === "CLOSED") subscribed.reject(new Error(`the relay closed the subscription: ${b}`));
        else if (type === "EVENT") on(b);
      };
      ws.onclose = () => subscribed.reject(new Error("the relay closed the socket before the subscription"));
      try {
        await Promise.race([
          subscribed.promise,
          Bun.sleep(30_000).then(() => Promise.reject(new Error("waited 30 s to subscribe"))),
        ]);
      } catch (error) {
        ws.close();
        throw error;
      }
      return ws;
    }

    /**
     * Watches the person's DM with the coworker and keeps when each typing event (kind 20002) of the
     * coworker's there arrived. The relay keeps no typing, so only a live subscription sees it.
     */
    async function typing() {
      const seen: number[] = [];
      const ws = await subscribe("rosa", [{ kinds: [20002], "#h": [dm] }], (event) => {
        if (event.pubkey === keys.wren) seen.push(performance.now());
      });
      return { seen, [Symbol.dispose]: () => ws.close() };
    }

    return {
      url,
      /** Each writer's and the coworker's public key, in hex. */
      keys,
      /** `who` writing `text` at `place` (see `write`). */
      write,
      /** The typing the coworker shows in the person's DM from now (see `typing`). */
      typing,
      /** The events the relay keeps that `filters` match, as `who` reads them. */
      async query(who: Writer, filters: object[]) {
        const found: BuzzEvent[] = [];
        (await subscribe(who, filters, (event) => found.push(event))).close();
        return found;
      },
      /** The key the relay signs its own events with, such as its member list, from its NIP-11 document. */
      async relayKey() {
        const nip11 = await fetch(`http://127.0.0.1:${port}`, {
          headers: { accept: "application/nostr+json", host: new URL(url).host },
        });
        return ((await nip11.json()) as { self: string }).self;
      },
      /** `who`'s DM with key `to` (see `dmWith`). */
      dmWith,
      /** The emoji the coworker has on message `event` now. */
      reactions: async (event: string): Promise<string[]> =>
        JSON.parse((await cli(["reactions", "get", "--event", event])).toString())
          .reactions.filter((r: { pubkeys: string[] }) => r.pubkeys.includes(keys.wren))
          .map((r: { emoji: string }) => r.emoji),
      /** harbor-ops's channel id. */
      channel,
      /** The coworker's messages in harbor-ops as `who` reads them, oldest first. */
      inHarborOps: (who: Writer = "rosa") => coworkers(["get", "--channel", channel], who),
      /** The coworker's messages in the harbor-ops thread under event `root`, oldest first. */
      thread: (root: string) => coworkers(["thread", "--channel", channel, "--event", root]),
      /** The coworker's message `text` in the harbor-ops thread under `root`, waiting up to `seconds` for it. */
      inThread: (root: string, text: string, seconds: number) =>
        settled(
          `the coworker's "${text}" in the thread`,
          async () => {
            const said = (await coworkers(["thread", "--channel", channel, "--event", root])).find(
              (m) => m.content === text,
            );
            if (!said) throw new Error("not yet");
            return said;
          },
          seconds,
        ),
      /** The coworker's messages, or key `from`'s, in `who`'s DM with it, oldest first. */
      dmOf: async (who: Writer, from = keys.wren) =>
        coworkers(["get", "--channel", await dmWith(who, from)], who, from),
      /** The first message of key `from` in `who`'s DM with it, waiting up to `seconds` for it. */
      answerFrom: (who: Writer, from: string, seconds: number) =>
        settled(
          "an answer in the DM",
          async () => {
            const [first] = await coworkers(["get", "--channel", await dmWith(who, from)], who, from);
            if (!first) throw new Error("none yet");
            return first;
          },
          seconds,
        ),
      /**
       * Sets, with Buzz's CLI, the profile of the agent whose secret key is `key`, with its owner's NIP-OA tag
       * `tag`, as something other than duck may have: Buzz's CLI writes the name as display_name.
       */
      async profileAs(key: string, tag: string, profile: { name: string; picture: string; about: string }) {
        const vars = env("agent", { BUZZ_PRIVATE_KEY: key, BUZZ_AUTH_TAG: tag });
        const { name, picture, about } = profile;
        const args = ["users", "set-profile", "--name", name, "--avatar", picture, "--about", about];
        await podman(["exec", ...vars, at("rosa"), "buzz", ...args]);
      },
      /** Sets the name `who` gives in Buzz. */
      rename: (who: Writer, name: string) => cli(["users", "set-profile", "--name", name], undefined, who),
      /** The person's NIP-OA tag for coworker key `agent`, which claims it as hers. */
      tagFor: authFor,
      /** `who`'s NIP-OA tag for Buzz key `agent`: the ownership proof Buzz's desktop copies for them. */
      proof: (who: Writer, agent: string) => authTag(secrets[who], agent),
      meet,
      presence,
      person: {
        /** Waits until the coworker, or the coworker whose key is `agent`, is online in Buzz. */
        online: (seconds = 60, agent = keys.wren) =>
          settled(
            "the coworker online in Buzz",
            async () => {
              const status = await presence(agent);
              if (status !== "online") throw new Error(`presence ${status}`);
            },
            seconds,
          ),
        /** Writes `text` with `files` in the DM with the coworker. Returns when the send began. */
        send: async (text: string, files: { name: string; bytes: string }[] = []) =>
          (await write("rosa", "dm", text, { files })).began,
        /** The coworker's next message in the DM not yet taken, waiting up to `seconds` for it. */
        async next(seconds: number): Promise<BuzzMessage> {
          const message = await settled(
            "the coworker's next message in Buzz",
            async () => {
              const found = (await read()).find((m) => !taken.has(m.id));
              if (!found) throw new Error("none yet");
              return found;
            },
            seconds,
          );
          taken.add(message.id);
          return message;
        },
        /** The coworker's messages in the DM so far. */
        read,
        /** The bytes of relay media at `url`, as the person's CLI fetches them. */
        file: (url: string) => cli(["media", "get", url, "-o", "-"]),
      },
      [Symbol.asyncDispose]: teardown,
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

export type Buzz = Awaited<ReturnType<typeof startBuzz>>;

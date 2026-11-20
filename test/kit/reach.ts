import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

/**
 * Where a kit server listens, and the host name the firm's setup gives duck for it. Measured on rootless
 * podman 5.7.0 with pasta, on its default network and on a network of its own: a container reaches a
 * server on the host at host.containers.internal only when the server listens on every address, and is
 * refused when it listens on loopback alone.
 */
export type Reach = { bind: string; host: string };

/** For a test whose client runs in this process. */
export const LOCAL: Reach = { bind: "127.0.0.1", host: "127.0.0.1" };

/** For a firm whose duck container calls the kit. A coworker's container reaches no address of this machine's. */
export const FROM_CONTAINERS: Reach = { bind: "0.0.0.0", host: "host.containers.internal" };

/**
 * For a server that both a firm's containers and a duck command run on this machine call, such as the
 * storage bucket. pasta gives a container this machine's address on the interface of its default route, so
 * that address reaches the container itself; any other of the machine's addresses reaches the machine.
 * Measured on podman 5.7.0: docker0's and tailscale0's addresses are reached, eth0's is refused.
 */
export function bothReach(): Reach {
  const route = readFileSync("/proc/net/route", "utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .find((fields) => fields[1] === "00000000")?.[0];
  const host = Object.entries(networkInterfaces())
    .filter(([name]) => name !== route)
    .flatMap(([, addresses]) => addresses ?? [])
    .find((a) => a.family === "IPv4" && !a.internal)?.address;
  if (!host)
    throw new Error(
      "this machine has no address beside its default route's for its containers to reach it at",
    );
  return { bind: "0.0.0.0", host };
}

/** A port on this machine nothing listens on now. */
export function freePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

/** Everything the kit saw go wrong outside a test's own calls, such as a model request no rule matched. */
export class Trouble {
  readonly seen: Error[] = [];
  add(error: Error) {
    this.seen.push(error);
  }
  /** Throws the first trouble seen, so a test fails on it and not on what it caused later. */
  check() {
    const first = this.seen[0];
    if (first) throw first;
  }
  /** Forgets what was seen, for the next step. */
  clear() {
    this.seen.length = 0;
  }
}

/** Waits up to `seconds` for `ok` to hold, failing on any trouble seen meanwhile. */
export async function until(what: string, ok: () => boolean, seconds: number, trouble?: Trouble) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    trouble?.check();
    if (ok()) return;
    if (Date.now() > end) throw new Error(`waited ${seconds} s for ${what}`);
    await Bun.sleep(20);
  }
}

/**
 * Waits up to `seconds` for `l` to open, failing on any trouble seen meanwhile, so a hold that is never
 * reached fails the test with its reason rather than timing it out.
 */
export async function reachedIn(what: string, l: ReturnType<typeof latch>, trouble?: Trouble, seconds = 60) {
  let open = false;
  void l.opened.then(() => {
    open = true;
  });
  await until(what, () => open, seconds, trouble);
}

/** A promise the test opens. */
export function latch() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

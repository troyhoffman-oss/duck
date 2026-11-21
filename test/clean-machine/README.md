# The setup-from-the-repo test

Stage two's first test (SPEC.md, ROADMAP.md): a coding agent that has never seen duck sets duck up for a made-up firm from this repo alone, by following SETUP.md on an empty server, until the firm's first coworker answers its person in Buzz. A person runs it and plays the firm's admin. Nothing here runs in CI.

## Start

On a Linux host with rootless podman 5 (netavark and pasta) and bun, in this repo after `bun install --frozen-lockfile`:

```sh
bun test/clean-machine/world.ts
```

It stays in the foreground until it is stopped. To keep it apart from a terminal, run it as a user unit: `systemd-run --user --unit duck-clean-world --collect --working-directory="$PWD" "$(command -v bun)" test/clean-machine/world.ts`, and read what it prints with `journalctl --user -u duck-clean-world`.

It starts, each named for this test:

- **The empty server,** the container `duck-clean-machine`, built from the [Containerfile](Containerfile): Debian 13 with systemd as its init, ssh, sudo, apt, curl and network out, and nothing SETUP.md installs. Its account `admin` has sudo. Its `/home` is the volume `duck-clean-machine-home`. Its ssh is on this host's loopback, with a key of its own in `~/.duck-clean-machine/`.
- **The firm's Buzz relay,** the kit's throwaway relay at Buzz's pinned commit (`test/kit/buzz.ts`), the containers and network labelled `duck.kit=duck-clean-buzz`. Rosa Alvarez, the made-up firm's person, owns the community and is the first coworker's person. You act as her.
- **A stand-in model** on the Messages API (`test/kit/model.ts`). It wants its key, takes any model name, and answers every call with a line that quotes the end of what it was sent.
- **A stand-in bucket** (`test/kit/bucket.ts`) named `harbor-backup`.

It prints the ssh command, the relay's address, the model's and the bucket's, and the names of the four secrets: `model-key`, `bucket-key`, `bucket-secret` and `backup-password`. It never prints their values; only the `secret` hand writes them, into the machine.

## The brief

Give a fresh coding agent these words, with the ssh command filled in, and nothing more:

> Please set duck up for our firm, Harbor, on our new server. The repo is https://github.com/troyhoffman-oss/duck. You reach the server with `ssh -i <key> -p <port> admin@127.0.0.1` from this machine; admin has sudo. Ask me whatever you need.

Answer its questions from what the world printed, as an admin would. Tell it nothing SETUP.md should have told it; where you had to, that is a finding.

## The admin's hands

Each is `curl --fail-with-body -sS http://127.0.0.1:4799/<hand> --data-binary '<words>'`, run on the host:

- `admin <key>`: Rosa, the community's owner, makes duck's Buzz key an admin (SETUP.md step 7).
- `secret <file> <NAME> <model-key|bucket-key|bucket-secret|backup-password>`: the admin adds `NAME=<that secret>` to the secret store file in the machine (step 5). The file must exist.
- `proof <key>`: the ownership proof Rosa copies in Buzz's desktop for the coworker's key `duck make` printed (step 9, without the plugin).
- `claim <coworker> [name]`: Rosa claims the coworker in New agent with duck's plugin (step 9, with it), through the kit's stand-in for Buzz's desktop (`test/kit/plugin-host.ts`).
- `judge <key> <line>`: Rosa writes the line to the coworker with that Buzz key in their DM, and it prints each answer with the seconds after her send. It fails when nothing comes in 300 s. **The test passes when the judge prints an answer from the coworker.**

To have the coworker on a real model instead, answer SETUP.md's model question with the Claude login route, and sign in with an account of your own when the agent hands you the command.

## Tear down

Stop it: Ctrl-C, or `systemctl --user stop duck-clean-world`. It removes the container `duck-clean-machine`, the volume `duck-clean-machine-home`, and the relay's containers and network, and stops the stand-ins. It keeps the image `duck-clean-machine`, which `podman rmi duck-clean-machine` removes, and the ssh key in `~/.duck-clean-machine/`.

## Where the machine is not a server

- It has only the 65,537 user ids of the host user who runs it. `admin` is the last and has all the others as subordinate ids; an account added later is given every id but its own, on its own, by a path unit. So rootless podman in `admin` gets every 16-bit id, and in an added account every one but 65535.
- It holds CAP_SYS_ADMIN and an unmasked `/proc` inside the host user's own user namespace, which rootless podman inside it needs.
- The host's AppArmor profile for pasta also covers the machine's pasta. Removing the last container on a podman network prints `rootless netns: kill network process: permission denied`; the container is removed.
- A reboot inside ends it.
- The relay is `ws://`, not `wss://`, and the relay, model and bucket listen on every address of the host, as the kit's do.

# Setting duck up

This file is for a coding agent. An admin of a firm has pointed you at this repo and wants duck running for their firm. Follow the steps in order. Each step ends on a check; go on only when it passes. Where this file and the code disagree, the code wins: `duck check` is the source of truth for what a setup must hold, and [examples/harbor/duck.yaml](examples/harbor/duck.yaml), the setup of a made-up firm, shows the keys a firm sets, each with a comment. [SPEC.md](SPEC.md) is the design and has the words this file uses.

In this file `duck <command>` means `bun <duck>/src/duck.ts <command>`, where `<duck>` is the folder you clone duck into in step 3. Every command but `duck --help` reads `duck.yaml` from the folder it runs in, so run them from the firm's setup folder (step 4). `<firm>` is the firm's name in its `duck.yaml`.

## What duck is, in one paragraph

Each firm runs duck on its own Linux server, under rootless podman. One `duck-<firm>` container holds duck itself; each coworker runs goose in a `duck-<firm>-<coworker>` container that holds no keys. People talk to their coworker in Buzz. duck has an identity of its own in the firm's Buzz community, and a private system channel between it and each person (duck's channel), which Buzz lists nowhere, is where duck's plugin finds the coworker offered to them and sends their claim. Nobody chats with duck. The firm's setup is one file, `duck.yaml`, in a private repo of the firm's own. duck keeps its coworkers, their facts and their keys itself, in the storage folder the setup names.

## Ask the admin first

Put these to the admin before step 2, in plain words. The admin alone decides those marked **admin**. For the rest, propose the default shown and go on unless they object.

1. **admin.** Which Linux server should duck run on, and how do you reach it? If there is none, renting one is their decision.
2. **admin.** Which Buzz community is the firm's? What is its relay address (it starts `wss://`, or `ws://` on a private network)? Who is its owner, with Buzz's desktop app? Only the community's owner can make duck's key an admin (step 7), and duck stays in Buzz while its key is an admin.
3. **admin.** How should coworkers reach the model? Either a Claude subscription login, which someone signs in to on the server once (whose account?), or an API key in Anthropic's format (whose key?). The login is the firm's account, not each person's.
4. **admin.** Where do the firm's secrets live? In a file on the server only duck reads, or in a secret store the firm already has, from which that file is filled.
5. **admin.** Which existing S3-compatible storage bucket should every coworker be copied to each night, and who holds its access key? duck encrypts the copies with a password. The admin must keep that password in a second place off the server: without it the copies cannot be read, and without a bucket a dead server loses every coworker.
6. **admin.** Where should the firm's private setup repo live, such as a private repository the firm owns? A private repository on the server itself is enough to start. Then the setup repo and the secret store file exist only on that server and are not in the nightly copies, so the admin keeps a copy of both elsewhere.
7. **admin.** Who gets the first coworker? Their name in Buzz, and the coworker's name.
8. The firm's short name. Default: one lowercase word, since it names the firm's containers and its folder in the bucket.
9. The firm's time zone, such as `America/Chicago`. Default: the admin's own.
10. How work is done at the firm, in a few lines, for the sign. Default: you draft it from what the admin says and they approve it.
11. Any tools or sources to plug in now, each an MCP server with its address and key. Default: none; plugs are added later with a line of setup.
12. Whether the firm has a decisions API for the sorter's cheap model. Default: none, and the sorter is `off`.

You may choose without asking: the folders, which duck's account must own, such as under its home folder (harbor's `/var/lib` and `/etc` paths need root to make); the port duck listens on; the times, quiet hours, caps and limits, which you take from harbor; the model's name, one of `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`, the names whose cost the model relay knows (any other runs and shows no cost); and each person's handle, one word from their name.

## Rules that protect the firm

- Secrets go only in the secret store file. Never put one in a repo, a chat, your output or a command line. The setup names each secret; `duck check` prints names, never values.
- The firm's setup lives in the firm's own private repo, never in duck's repo or a fork of it.
- The storage folder holds duck's keys and every coworker's memory. It lives outside every repo.
- A lifecycle rule on the backup bucket has a prefix and never covers `restic/`, where duck keeps the copies; duck prunes them itself, and a rule over them deletes data later copies still use.

## 1. Agree the answers

Write the admin's answers down where you can read them back. Check: you have an answer or an agreed default for every question above.

## 2. Prepare the server

duck runs as an ordinary Linux account, not as root. Install what follows from the distribution's packages or each project's own releases, at the versions named. That account needs:

- systemd, with lingering on, so the firm's containers start after a reboot: `loginctl enable-linger <account>` (run as an administrator). Work as that account in a login of its own, such as over ssh, since `duck install` runs `systemctl --user`, which needs the account's own user session; `su` gives none.
- rootless podman, with the netavark network backend: `duck install` makes each coworker's network with `--opt isolate=true`, and duck reaches each coworker's container by its name. duck pins no podman version.
- nftables, which netavark needs for a coworker's network.
- bun 1.4.4, the version `package.json` names in `packageManager`.
- restic 0.20.0, the version `package.json` pins; `duck backup` and `duck restore` run it on the server.
- git.
- Outbound access to the registries and downloads duck's images are built from (see [src/setup/Containerfile](src/setup/Containerfile)), the Buzz relay, the model's address, the bucket, and on the login route the npm registry, which the sign-in command in step 6 fetches `claude` from.

Nothing needs to reach the server from outside for a coworker that talks in Buzz: duck reaches Buzz, the model and the bucket outward.

Check, as that account: `loginctl show-user $USER --property Linger --value` prints `yes`; `systemctl --user is-system-running` prints a state and no bus error; `podman info --format '{{.Host.NetworkBackend}}'` prints `netavark`; after `podman network create --opt isolate=true duck-try`, `podman run --rm --network duck-try docker.io/library/debian:trixie-slim true` exits 0, and `podman network rm duck-try` then removes the network; `bun --version` prints `1.4.4`; `restic version` names 0.20.0.

## 3. Get duck

Clone this repo into a folder that will stay where it is, since `duck install` writes that path into a systemd unit. In it run `bun install --production --frozen-lockfile`.

Check: `duck --help`, run from anywhere, prints the list of commands and exits 0.

## 4. Make the firm's setup repo

Make the firm's private repo, and in it a setup folder holding copies of `examples/harbor/duck.yaml`, `examples/harbor/sign.md` and `examples/harbor/sorter.md`. Then edit them:

- `duck.yaml`: set `firm`, `zone`, `listen`, `storage.folder` (an absolute path outside the repo), `secrets.file` (an absolute path outside the repo), `backup`, `model` and `buzz.relay` from the answers. Give each secret a name of the firm's own. Keep every other top-level block harbor has (`sign`, `sorter`, `timers`, `compaction`, `settings` and the rest): duck reads them without asking whether they are there. Take out harbor's `plugs` and `doors`: their addresses are made up, and its doors and calendar name a coworker yours does not have. `duck check` refuses a plug or door that names a coworker not yet made, so a plug added now says `coworkers: everyone`; one for named coworkers, and `doors.<coworker>`, wait until step 9 has made them.
- `sorter.md`: rewrite harbor's lines about Wren, Rosa and apartments for the firm. Keep the four lines that start `` - `noise`: ``, `` - `urgent`: ``, `` - `wake`: `` and `` - `addresses AI`: ``; `duck check` needs all four, even with the sorter off.
- `sign.md`: the firm's own words on how work is done there.

Set `sorter.mode` to `off` unless the firm has a decisions API, in which case `observe`, with its `address`, `key` and `model`. With it `off`, delete harbor's `sorter.address`, `sorter.key`, `sorter.model` and `sorter.request`: `duck check` asks the secret store for any `key` the setup names, used or not. Make the storage folder and the secret store file, both owned by duck's account, the file with mode 600. Commit the setup folder and, where the repo has a remote, push it there with the admin's own access.

Check: the repo holds the setup and no secret, and `git status` in it is clean and, where it has a remote, up to date with it.

## 5. Fill the secret store

The secret store is the file `secrets.file` names, one `NAME=value` line per secret, exactly so: no quotes, no `export`, no spaces around `=`, Unix line ends; duck takes everything after the `=` as the value. It holds the backup's key, secret and password, the model key on the API-key route, the sorter's key if it has one, each plug's keys and its `events.push` key, and each door's `key` and, on a text, email or telegram door, `auth`. A plug address or header that says `${NAME_{person}}` needs one line per person, with `{person}` replaced by their handle. Have the admin put the values in the file themselves. Or leave the file step 4 made empty, with mode 600, tell the admin its path and the exact names it needs, and have someone the admin trusts fill it; you never see a value. A firm with a secret store of its own fills the file from it by its own means; duck reads only the file. No value may pass through your output or a command line.

Check: `duck check` prints no line that starts `the secret store`. It asks for a person's plug keys only once their coworker is claimed; `duck make` for a person asks for them first (step 9).

## 6. Set up the model route

On the API-key route, `model.route` is `api-key`, with `address`, `key` (the secret's name) and `coworker` (the model's name), as harbor has them.

On the login route, `model.route` is `claude-login`, `model.login` is a folder outside the repo, and `coworker` is the model's name; delete harbor's `model.address` and `model.key`, or `duck check` asks the secret store for that key. `duck check` then prints the command that signs that folder in on the server. Hand it to the account's holder to run: it opens a sign-in that a person completes.

Check: `duck check` prints no line about `model` or the Claude login.

## 7. Add duck to the firm's Buzz community

Run `duck check`. With `buzz.relay` set, its last lines include one that begins `still to do: duck's Buzz key is` and a 64-character key, until the running duck has found that key an admin in the community. Give the key to the community's owner from question 2, with the step exactly as duck words it; only the owner can take it:

> the community's owner opens Settings, then Community admin, then Membership, chooses Add directly, puts that key in Public identity, chooses the role Admin and presses Add member, or where Membership lists that key already, chooses Make admin on it

Nothing comes back to the server and the setup holds nothing about it. duck shows in the member list as an admin named duck, and the plugin knows duck only by that role. Once step 8's install is up, the running duck finds the key an admin within a minute. Until then duck's channels are off, and coworkers can still be made with no member and claimed with `duck make` and `duck claim` (step 9, second path).

Check: after step 8's install and the owner's step, `duck check` prints no `still to do` line, and duck's log (`podman logs duck-<firm>`) has no line after the owner's step that duck's Buzz key is not an admin on the community's member list.

## 8. Check and install

Run `duck check` and fix each line it prints until its last line is `the setup is ready to install` and it exits 0. A `still to do` line above it does not stop an install; step 7 deals with it. Then run `duck install`. The first install builds duck's two images, which takes a while.

Check: `duck install` exits 0 and its last line is `duck: started`. `podman ps --filter label=duck.firm=<firm>` shows `duck-<firm>` up. `systemctl --user is-enabled duck-firm-<firm>.service` prints `enabled`. With `buzz.relay` set, `systemctl --user is-active duck-firm-<firm>-install.path` prints `active`.

## 9. Make the first coworker, and its person claims it

A coworker's name is lowercase letters, digits and dashes, from a letter. Its handle is the person's one word, letters, digits and underscores, unique in the firm.

**With duck's channels on.** Run `duck make <coworker> <handle> "<their name in Buzz>"`. A name that is not exactly one person's in Buzz is refused; give their 64-character Buzz key instead. A make is also refused, naming the secret, while a plug the coworker gets lacks that person's key in the secret store. duck prints `duck made coworker <coworker>; its Buzz key is <key>` and offers the coworker to the person in duck's channel. They install duck's plugin in Buzz's desktop app (the phone app cannot), once:

> open Settings, then Plugins, then Manage plugins, and press Add; put this repo's address in Git or GitHub repository and `plugin` in Folder (optional), press Find, keep Enable plugin on and press Install plugin

Then they claim it themselves:

> open Agents, press New agent (and Create a new agent if it asks), choose duck as the harness, name it, press Create agent and then Let’s go

duck claims it for them, and a systemd unit runs `duck install` on the server. No admin needs to be there.

A person who lives in another time zone than the firm's sets theirs once they have claimed the coworker, in the plugin's Preferences tab or by telling the coworker. Where the setup has Buzz, duck installs again on its own; without it, the coworker's own clock takes the new zone at the next `duck install`.

**For a person with no plugin, or with duck's channels off.** With duck's channels off, run `duck make <coworker> <handle>`. Give the person the key `duck make` printed and these steps, in Buzz's desktop app (the phone app cannot):

> open Settings, then Security, then Authorize external identity (Security is under Buzz in Settings' list), put the key in Application public key (hex), press Authorize identity and then Authorize this key, then press Copy ownership proof and send the proof to your admin

and have them send you the proof they copy. First make sure the secret store holds that person's key for every plug the coworker gets: `duck claim` records the claim before it installs, and the install then stops on a missing key until you add it and run `duck install`. Then run `duck claim <coworker> '<proof>' "<their name>"`, which claims and installs.

Check: the install ends with the lines `<coworker>: started` and `duck: kept` (after a claim from the plugin, read them with `journalctl --user -u duck-firm-<firm>-install.service`), and `podman ps --filter label=duck.firm=<firm>` shows `duck-<firm>-<coworker>` up.

**A team coworker.** A coworker that does one function's work for many people, such as an accountant, is made like any other, for the person who answers for it, with its own handle and its team's channel by its Buzz id after the member: `duck make <coworker> <handle> "<their name in Buzz>" <channel id>`. Its handle is its own, so the secret store holds a key of its own for each plug it gets. Once claimed, its person adds it to that channel in Buzz. Anyone in the community may then ask it by mentioning it, and it answers in their thread; a held call is asked of its person, in their DM with it. Buzz hands a coworker no one's DM but its own person's, so a colleague asks it in a channel.

**Optional, before the claim: history from before.** If the person used Claude, ChatGPT or a Hermes agent, `duck import <coworker> <kind> <path>` loads it, with kind `claude` (a claude.ai export's `conversations.json`), `chatgpt` (a ChatGPT export's `conversations.json` or one of its parts) or `hermes` (a Hermes `state.db` or profile folder). It prints what it loaded, and the coworker dreams over it.

## 10. The plugin

duck's plugin is `plugin/manifest.json` and `plugin/plugin.js` in this repo, the same files for every firm. In Buzz's desktop app it adds duck as a harness in New agent, which claims a coworker; a To-dos and a Preferences tab on the coworker's page; and, for the community's owners and admins, a Coworkers card in Settings. It talks with duck only in duck's channel, which Buzz lists nowhere. Without it, as on Buzz's phone app, a person claims a coworker only through an admin's `duck claim`, pauses it and sets its quiet hours, messages an hour and their time zone only by telling it, and cannot rename it, change its picture or remove it. A person installs it as step 9 says.

Check: in the person's Buzz desktop app, Settings, then Plugins, then Manage plugins lists duck, and New agent offers duck as a harness.

## 11. The first conversation

The person opens their coworker's own DM in Buzz and writes to it.

Check: the coworker answers in that DM. Where the answer needs work, a first line saying what it is about to do comes before it.

## 12. Backups, and a restore check

duck copies every coworker to the bucket each night at `backup.at`, a cron expression in the firm's zone (default `0 2 * * *`). Make the first copy now with `duck backup`; it prints one line per coworker, `<coworker>:` and what restic stored.

Then prove a restore without touching the running firm. Make an empty folder outside the firm's repo, copy `duck.yaml` into it, and change only `storage.folder` there to a new empty folder. In that folder run `duck restore <coworker>`. Never run `duck install` there: it would replace the running firm's containers, which have the same names. When the check passes, ask the admin before deleting the folder; it holds the coworker's memory and keys.

Check: `duck restore` prints `restored <coworker>'s copy of <time> into <folder>; duck install starts it`, and that folder holds `duck.db` and `coworker.json`.

A copy holds each coworker's folder: its memory, its facts and its own Buzz key. It does not hold what sits at the top of the storage folder: duck's own Buzz key and the model calls per job an admin set. To bring the firm back on a new server: steps 2 to 6 with the same setup and secrets, `duck restore <coworker>` for each coworker into the new storage folder, then step 7 again for duck's new key, then `duck install`.

## Later: updating duck

In `<duck>`, check out the newer commit of `main` and run `bun install --production --frozen-lockfile`. Then, in the firm's setup folder, run `duck check` and `duck install`. A change to duck's own code makes the `duck-<firm>` container new, which cuts every coworker's runs; each starts again. A change to the setup does the same.

## When something fails

- `duck check` names each problem on a line of its own, with what to do.
- `duck install` stops at the first failure: `the setup has problems; run duck check:` with the lines; a podman command and podman's own error; or `duck is not ready after 120 s; see podman logs duck-<firm>`.
- duck's log is `duck.log` in the storage folder. It outlives a new container. It holds, among the rest, a backup that failed, an offer not sent, and `duck's Buzz key … is not an admin on the community's member list …` until the owner's step of step 7.
- A coworker's goose: `podman logs duck-<firm>-<coworker>`.
- An install a claim from the plugin started: `journalctl --user -u duck-firm-<firm>-install.service`.

## Reference

- **Commands.** `duck --help` lists them: `check`, `install`, `make`, `claim`, `import`, `backup`, `restore`.
- **duck.yaml.** [examples/harbor/duck.yaml](examples/harbor/duck.yaml) has the keys a firm sets, each with a comment. Keys it leaves out: `model.login` (step 6), `settings.locked`, `buzz.tools`, a plug's `others`, a text door's `line` and `auth`, and an email door. The type `Setup` in [src/setup/index.ts](src/setup/index.ts) lists every key duck reads, and SPEC.md part 1 says what each means. `duck check` refuses a setup that lists people or coworkers: duck keeps those itself.
- **Model routes.** `api-key` and `claude-login` (SPEC part 12).
- **Doors.** Every claimed coworker has a `buzz` door, which duck makes at `buzz.relay`. The setup may add, under `doors.<coworker>`, an `http` door, a `text` door with a `line` and an `auth`, which `duck check` reads as the name of a secret, or an `email` door: `kind: email`, `address` the mail service's API (`https://api.agentmail.to` for AgentMail, the first service), `mailbox` the coworker's own address there, `key` the name of the secret holding a key scoped to that one mailbox, and `auth` the name of the secret holding the person's own mail address. The email door opens no port: it holds the service's stream. Or a `voice` door, a call in Buzz: `kind: voice`, `address` the speech model's live API (`wss://api.openai.com/v1/live/sessions` for OpenAI, the first service), `model` and `voice` what it speaks with there, and `key` the name of the secret holding that service's key. The person starts a call in their DM with the coworker, or in a private channel of just the two of them, and the coworker joins it. What the person says in a call, and what the coworker answers there, goes to that service. Or a `telegram` door, the person's private chat with a bot made for the coworker with Telegram's @BotFather: `kind: telegram`, `address` the Bot API (`https://api.telegram.org`), `key` the name of the secret holding the bot's token, and `auth` the name of the secret holding the person's own Telegram user id, its digits only. It opens no port: it polls the bot's updates, so no webhook may be set on that bot, and the person writes to the bot once before it can write to them.
- **Plugs.** One entry under `plugs` each: an address, headers that name secrets, the coworkers it is given to (`everyone` or a list), its tools' states (`free`, `ask first`, `removed`), and how its events arrive, pushed or polled (SPEC part 1, Plugs).
- **A plug that wants each person's sign-in.** Its `signin` names the service's `authorize` and `token` addresses, `client`, the firm's app's client id there, `key`, the name of the secret holding the app's client secret, `scopes`, and `page`, where the firm hosts duck's page (SPEC part 9, Sign-in). `duck check` names what one lacks.
  - The page is the one file `signin/index.html` in this repo, served as it is at an HTTPS address the firm controls; it loads and sends nothing. Register that exact address as the app's redirect address. Google asks that a redirect's domain be one of the project's authorized domains, and a domain the firm owns and has verified is the sure choice. Whether Google accepts the firm's own name on a shared host, such as GitHub Pages, has not been tried.
  - Microsoft Entra: register the address under the Web platform, not single-page application, since duck trades the code with the app's secret. Ask for `offline_access` among the scopes, or no refresh token comes.
  - Google: a Web application client. Give `authorize` Google's own `access_type=offline&prompt=consent`, which duck keeps on every link, or no refresh token comes.
  - Microsoft's codes last about a minute, so the person sends the string as soon as the page shows it.
- **What reaches duck from outside.** A plug that pushes posts to `/events/<plug>` and an `http` door's other end to `/doors/<coworker>/<door>`, both at `listen`, which harbor binds to loopback. duck ships no proxy or certificate: making that address reachable from the source is the firm's.

## Not built yet

- `duck update`: there are no named releases; update by checkout as above.
- Nightly copies kept on the server itself: the copies go only to the bucket, which the setup must name.
- A recommended server size: duck has not measured one.
- The invitation each person gets, which would install Buzz with the plugin.
- The office plug, for Microsoft 365 and Google Workspace mail, calendar and files. A plug that wants each person's sign-in connects from a link already (Reference, A plug that wants each person's sign-in).
- A coworker offered to everyone, an admin confirming a claim, and a person creating a coworker of their own.
- The first conversation's set questions: how they want to work, their voice, history and their mail link.
- A request the plugin sends while duck is down gets no answer; the plugin says duck did not answer.
- A person leaving and the handover.
- Of team coworkers: what one says on its own going to its team's channel, another coworker asking one, and its person naming who may ask.
- A real reboot of a firm's server has not been run; the boot unit is proven by starting it as a boot does.

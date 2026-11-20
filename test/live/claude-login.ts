// The claude-login route, live: harbor installed on a real Claude login, three turns in one main conversation
// on harbor's coworker model, the last one calling goose's shell. It spends the login's subscription, so it is
// run by hand on the firm's server, never by `bun test`:
//   bun test/live/claude-login.ts <the Claude login's home folder>
import { container } from "../../src/setup";
import { startFirm, until } from "../kit";

const login = process.argv[2];
if (!login) throw new Error("usage: bun test/live/claude-login.ts <the Claude login's home folder>");

// `claude` gives the model the login's email address; this check shows none.
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const hide = (text: string) => text.replace(EMAIL, "<an email address>");

await using firm = await startFirm({ login });
const relay = () =>
  Bun.spawnSync(["podman", "logs", container(firm.name)], { stdout: "pipe", stderr: "pipe" })
    .stdout.toString()
    .split("\n")
    .filter((line) => line.startsWith('{"relay"'));
const ended = () =>
  firm.db().query<{ n: number }, []>("select count(*) as n from runs where ended_at is not null").get()?.n ??
  0;

let turns = 0;
let emails = 0;
async function turn(text: string) {
  const [logged, seen] = [relay().length, firm.person.received.length];
  const sent = performance.now();
  await firm.person.send("desk", text);
  turns++;
  await until(`run ${turns} to end`, () => ended() >= turns, 300, firm.trouble);
  const replies = firm.person.received.slice(seen);
  console.log(`\nperson: ${text}`);
  console.log(`first line after ${(((replies[0]?.at ?? Number.NaN) - sent) / 1000).toFixed(2)} s`);
  for (const reply of replies) {
    emails += (reply.text.match(EMAIL) ?? []).length;
    console.log(`wren: ${hide(reply.text)}`);
  }
  for (const line of relay().slice(logged)) console.log(`relay: ${line}`);
}

await turn(
  "Hi Wren, quick check before we start: what's my name, and which email address do you have for me?",
);
await turn("Thanks. In one short sentence, what did I just ask you?");
await turn("Run `uname -sm` in your shell and tell me exactly what it printed.");
const calls = firm.db().query("select tool, status from tool_calls").all();
console.log(`\ntool calls: ${JSON.stringify(calls)}`);
console.log(`email addresses in wren's replies: ${emails}`);

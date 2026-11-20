// duck's plugin for Buzz's desktop app (SPEC part 11, The plugin). It registers the duck coworker type in New
// agent. It holds no address and no key: it reads what duck writes in the person's channel with duck, a system
// channel Buzz lists nowhere, and writes there only its requests, artifacts Buzz signs as the person, in fixed
// words; Buzz itself signs the claim.
export const inject = ["react", "agents", "relay", "settingsCards"];

/** duck's answers to a claim that stands: the first claim, and the same proof sent again. */
const YOURS = /^That coworker is yours (now|already)\./;
const PUBLISHED = "Done: that coworker's profile in Buzz shows it now.";
const STOPPED = /^That coworker is stopped\./;
/** How long duck has to answer a request. */
const WAIT_MS = 30_000;
/** NIP-AR's artifact kind, the one kind Buzz's artifact writer signs. */
const ARTIFACT = 45010;

/** duck's mark, the small duck's track of brand/duck-track-small.svg, which follows the text colour. */
const TRACK =
  "M50 91 C44.5 91 40.6 88.2 38.2 83.6 L9.4 48.4 C6.8 45.2 7.4 40.6 11.6 40.2 C14 40 15.6 41.6 16.8 43.4 C24.5 50 37.5 46.5 45.2 30 L46.6 15.5 C47 11.4 53 11.4 53.4 15.5 L54.8 30 C62.5 46.5 75.5 50 83.2 43.4 C84.4 41.6 86 40 88.4 40.2 C92.6 40.6 93.2 45.2 90.6 48.4 L61.8 83.6 C59.4 88.2 55.5 91 50 91 Z";

export function apply(ctx) {
  const React = ctx.react;
  const h = (...args) => React.createElement(...args);
  const session = () => ctx.relay.snapshot().session;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  /** The keys of the community's owners and admins, by the member list its relay signs (NIP-43). */
  async function admins() {
    const s = session();
    const [members] = await s.read([{ kinds: [13534], authors: [s.relayAuthor], limit: 1 }]);
    return (members?.tags ?? [])
      .filter(([tag, , role]) => tag === "member" && (role === "owner" || role === "admin"))
      .map(([, key]) => key);
  }

  /** First value of tag `name` on `event`. */
  const tagOf = (event, name) => event.tags.find(([tag]) => tag === name)?.[1];

  /**
   * duck in this community and the person's channel with it: of the system channels (NIP-CL) labelled with the
   * person's key that a key the member list names as an owner or admin made, the oldest, as Buzz finds labelled
   * channels by their creator from the relay's own record. Only the community's owner makes a key an admin
   * (buzz-relay src/handlers/relay_admin.rs:319-338), so no coworker or other agent is taken for duck. With none,
   * duck has not written to the person yet.
   */
  async function duck() {
    const [s, owners] = [session(), await admins()];
    const settings = { consistency: "strong", signal: AbortSignal.timeout(WAIT_MS) };
    const found = await Promise.all(
      owners.map((creator) => s.channels.findLabeled({ creator, label: s.viewer }, settings)),
    );
    const [oldest] = found
      .flatMap((made, i) =>
        made.filter((c) => c.channelType === "system").map((c) => ({ ...c, key: owners[i] })),
      )
      .sort((a, b) => (a.createdAt ?? Infinity) - (b.createdAt ?? Infinity) || (a.id < b.id ? -1 : 1));
    return oldest ? { key: oldest.key, channel: oldest.id } : {};
  }

  /** The current artifacts in the person's channel with duck that `filter` matches, as the relay answers. */
  const current = async (d, filter) =>
    d.channel
      ? session().snapshotRead([{ artifact: "current", "#h": [d.channel], limit: 100, ...filter }], {
          signal: AbortSignal.timeout(WAIT_MS),
        })
      : [];
  /** What duck published of `types` in the person's channel with it. */
  const published = async (d, ...types) =>
    (await current(d, { "#type": types })).filter((a) => a.pubkey === d.key);
  /** The Buzz key of the coworker an artifact of duck's is for. */
  const agentOf = (a) => tagOf(a, "agent");

  /** Each coworker duck offered the person, by its name, with its Buzz key. */
  const offers = async (d) =>
    new Map((await published(d, "duck.offer")).map((a) => [JSON.parse(a.content).coworker, agentOf(a)]));

  /**
   * Writes `text` as a request in the person's channel with duck, a `duck.request` artifact Buzz signs as them,
   * and resolves with duck's answer, its revision of that request.
   */
  async function tell(text) {
    const [d, s] = [await duck(), session()];
    if (!d.channel) throw new Error("duck never offered you this coworker.");
    const id = crypto.randomUUID();
    const tags = Object.entries({ ar: "1", d: id, h: d.channel, type: "duck.request", title: "Request" });
    const signal = AbortSignal.timeout(WAIT_MS);
    const template = { kind: ARTIFACT, created_at: Math.floor(Date.now() / 1000), content: text };
    const request = await s.configArtifactWriter.sign(
      { ...template, tags: [...tags, ["op", "create"]] },
      signal,
    );
    await s.configArtifactWriter.publish(request, signal);
    for (const end = Date.now() + WAIT_MS; Date.now() < end; await sleep(500)) {
      const [answer] = await current(d, { "#d": [id] });
      if (answer?.pubkey === d.key) return answer.content;
    }
    throw new Error("duck did not answer in 30 seconds. Try again, or tell your firm's admin.");
  }
  /** Writes `text` to duck and throws duck's answer unless it is what `fits`. */
  async function ask(text, fits) {
    const answer = await tell(text);
    if (!(typeof fits === "string" ? answer === fits : fits.test(answer))) throw new Error(answer);
  }

  /** The name duck knows the coworker whose Buzz key is `pubkey` by, from its offer or its preferences. */
  async function nameOf(pubkey) {
    const own = (await published(await duck(), "duck.offer", "duck.person")).find(
      (a) => agentOf(a) === pubkey,
    );
    if (own) return JSON.parse(own.content).coworker;
    throw new Error("duck never offered you this coworker.");
  }
  /** Asks duck to publish the coworker's profile with `name` and, where given, `picture`. */
  async function profile({ pubkey, name, picture }) {
    const coworker = await nameOf(pubkey);
    await ask(`rename ${coworker} to ${name}`, PUBLISHED);
    if (picture) await ask(`picture ${coworker} ${picture}`, PUBLISHED);
  }

  const note = (text) => h("p", { className: "m-0 text-body-sm text-secondary" }, text);

  /** The pictures Buzz gave at provision, which it lists the agent with but does not give again at activate. */
  const pictures = new Map();

  /** The coworkers duck offered the person and not yet among their agents, to pick one of in New agent. */
  function Create({ config, onChange, disabled }) {
    const [list, setList] = React.useState(null);
    React.useEffect(() => {
      let shown = true;
      duck()
        .then(offers)
        .then((found) => {
          const mine = new Set(ctx.agents.snapshot().agents.map((a) => a.pubkey));
          const waiting = [...found].filter(([, key]) => !mine.has(key)).map(([name]) => name);
          if (!shown) return;
          setList(waiting);
          if (!config.coworker && waiting.length === 1) onChange({ coworker: waiting[0] });
        })
        .catch((error) => shown && setList(error));
      return () => {
        shown = false;
      };
    }, []);
    if (list === null) return note("Looking for the coworker your firm made for you…");
    if (list instanceof Error) return note(list.message);
    if (list.length === 0) return note("No coworker is waiting for you. Ask your firm's admin.");
    return h(
      "fieldset",
      { disabled, style: { border: 0, margin: 0, padding: 0, display: "grid", gap: "var(--space-2, 8px)" } },
      h("legend", { className: "buzz-field-label" }, "Your coworker"),
      ...list.map((name) =>
        h(
          "label",
          { key: name, style: { display: "flex", gap: "var(--space-2, 8px)", alignItems: "center" } },
          h("input", {
            type: "radio",
            name: "duck-coworker",
            checked: config.coworker === name,
            onChange: () => onChange({ coworker: name }),
          }),
          h("span", null, `${name}, made for you by your firm. The name you give it above is its own.`),
        ),
      ),
    );
  }

  /** The To-dos tab's groups, in order, by the group duck gives each item of its list (src/dms.ts). */
  const GROUPS = [
    ["you", "Needs you"],
    ["doing", "It's on it"],
    ["waiting", "Waiting"],
  ];
  /**
   * What duck published of `type` in the person's channel with duck, for the coworker whose key is `pubkey`
   * where given: null while it reads, false for nothing, or the error; and what reads it again.
   */
  function usePublished(type, pubkey) {
    const [found, setFound] = React.useState(null);
    const [reads, setReads] = React.useState(0);
    React.useEffect(() => {
      let shown = true;
      duck()
        .then(async (d) => {
          const mine = (await published(d, type)).find((a) => !pubkey || agentOf(a) === pubkey);
          return mine ? JSON.parse(mine.content) : false;
        })
        .then((content) => shown && setFound(content))
        .catch((error) => shown && setFound(error));
      return () => {
        shown = false;
      };
    }, [type, pubkey, reads]);
    return [found, () => setReads(reads + 1)];
  }
  /** The coworker's list as duck publishes it to its person, in their channel with duck: view only. */
  function ToDos({ agent }) {
    const [published] = usePublished("duck.list", agent.pubkey);
    if (published === null) return note("Reading its list…");
    if (published instanceof Error) return note(published.message);
    const items = published ? published.items : [];
    if (items.length === 0) return note("Nothing is on its list yet.");
    const list = (group) =>
      h(
        "ul",
        { className: "m-0 grid list-none gap-3 p-0" },
        ...items
          .filter((i) => i.group === group)
          .map((i) =>
            h(
              "li",
              { key: i.id, className: "grid gap-1" },
              h("span", { className: "text-body" }, i.title),
              h(
                "span",
                { className: "text-body-sm text-secondary" },
                [i.next, i.due && `due ${i.due}`].filter(Boolean).join(" · "),
              ),
            ),
          ),
      );
    const some = (group) => items.some((i) => i.group === group);
    return h(
      "div",
      { className: "grid gap-4" },
      ...GROUPS.filter(([group]) => some(group)).map(([group, title]) =>
        h(
          "section",
          { key: group, className: "grid gap-2" },
          h("h3", { className: "m-0 text-label" }, title),
          list(group),
        ),
      ),
      some("done") &&
        h(
          "details",
          { key: "done" },
          h("summary", { className: "text-label" }, "Done this week"),
          list("done"),
        ),
    );
  }

  /** duck's answers when a setting changed (src/dms.ts); any other is a refusal, shown as it is. */
  const SETTLED = /^(That coworker is (paused|resumed):|Done: that coworker's setting is changed\.)/;
  /** Its person's settings for the coworker, as duck publishes them; a change is a request in fixed words. */
  function Preferences({ agent }) {
    const [prefs, reread] = usePublished("duck.person", agent.pubkey);
    const [refused, setRefused] = React.useState("");
    if (prefs === null) return note("Reading its preferences…");
    if (prefs instanceof Error) return note(prefs.message);
    if (!prefs) return note("duck has not shown its preferences yet.");
    const { coworker, paused, quiet, messages_per_hour: perHour, zone, cost } = prefs;
    const send = (words) =>
      tell(words)
        .then((answer) => setRefused(SETTLED.test(answer) ? "" : answer))
        .catch((error) => setRefused(error.message))
        .then(reread);
    const [from, to] = quiet.value ?? ["21:00", "07:00"];
    const row = (setting, ...shown) =>
      h(
        "label",
        { className: "flex items-center gap-2" },
        ...shown,
        setting.locked && h("span", { className: "text-body-sm text-subtle" }, "Set by your firm"),
      );
    const input = (label, setting, props) =>
      h("input", { "aria-label": label, disabled: setting.locked, ...props });
    const times = [
      ["Quiet from", from, (at) => `${at}-${to}`],
      ["Quiet until", to, (at) => `${from}-${at}`],
    ];
    return h(
      "div",
      { className: "grid gap-4" },
      row(
        paused,
        input("Paused", paused, {
          type: "checkbox",
          role: "switch",
          checked: paused.value,
          onChange: (e) => send(`${e.target.checked ? "pause" : "resume"} ${coworker}`),
        }),
        h("span", { className: "text-body" }, "Paused: it does no work on its own and still answers you"),
      ),
      row(
        zone,
        h("span", { className: "text-body" }, "Time zone"),
        input("Time zone", zone, {
          type: "text",
          defaultValue: zone.value,
          onBlur: (e) =>
            e.target.value && e.target.value !== zone.value && send(`set ${coworker} zone ${e.target.value}`),
        }),
      ),
      h(
        "section",
        { className: "grid gap-2" },
        h("h3", { className: "m-0 text-label" }, "When it messages you"),
        row(
          quiet,
          input("Quiet hours", quiet, {
            type: "checkbox",
            checked: quiet.value !== null,
            onChange: (e) => send(`set ${coworker} quiet ${e.target.checked ? `${from}-${to}` : "none"}`),
          }),
          h("span", { className: "text-body" }, "Quiet hours"),
          ...times.map(([label, at, range]) =>
            input(
              label,
              { locked: quiet.locked || quiet.value === null },
              {
                key: label,
                type: "time",
                defaultValue: at,
                onBlur: (e) =>
                  e.target.value !== at && send(`set ${coworker} quiet ${range(e.target.value)}`),
              },
            ),
          ),
        ),
        row(
          perHour,
          input("Messages an hour", perHour, {
            type: "number",
            min: 1,
            max: 60,
            defaultValue: perHour.value,
            onBlur: (e) =>
              Number(e.target.value) !== perHour.value &&
              send(`set ${coworker} messages ${e.target.value} per hour`),
          }),
          h("span", { className: "text-body" }, "messages an hour at most, outside quiet hours"),
        ),
      ),
      refused && h("p", { className: "m-0 text-body-sm text-danger" }, refused),
      cost !== undefined &&
        h(
          "p",
          { className: "m-0 text-body-sm text-subtle" },
          `Model use this month at list price: $${cost.toFixed(2)}`,
        ),
    );
  }

  /** duck's answer when the most model calls of a job's run changed (src/dms.ts); any other is a refusal. */
  const LIMITED = /^Done: a job's run is cut off at that many model calls/;
  /** A coworker's state as the card shows it: whether its person added it, and if so whether it runs. */
  const stateOf = (c) =>
    c.state === "claimed"
      ? c.up
        ? "Running"
        : "Not running"
      : c.state === "stopped"
        ? "Stopped"
        : "Not added yet";
  /**
   * The firm's coworkers as duck publishes them to each owner and admin, in their channel with duck, and the
   * most model calls of a job's run, which a change sets by a request in fixed words.
   */
  function Coworkers() {
    const [firm, reread] = usePublished("duck.firm");
    const [refused, setRefused] = React.useState("");
    if (firm === null) return note("Reading your firm's coworkers…");
    if (firm instanceof Error) return note(firm.message);
    if (!firm) return note("duck has not shown your firm's coworkers yet.");
    const when = (at) => (at ? new Date(at).toLocaleString() : "Never");
    const cell = (text, key) => h("td", { key, className: "py-1 pr-4 text-body" }, text);
    const head = ["Coworker", "Person", "State", "Last ran", "This month"];
    return h(
      "div",
      { className: "grid gap-6" },
      h(
        "table",
        { className: "w-full text-left" },
        h(
          "thead",
          null,
          h("tr", null, ...head.map((t) => h("th", { key: t, className: "pb-2 pr-4 text-label" }, t))),
        ),
        h(
          "tbody",
          null,
          ...firm.coworkers.map((c) =>
            h(
              "tr",
              { key: c.name },
              cell(c.name, "name"),
              cell(c.person ?? "", "person"),
              cell(stateOf(c), "state"),
              cell(when(c.last_ran), "ran"),
              cell(`$${c.cost.toFixed(2)}`, "cost"),
            ),
          ),
        ),
      ),
      h(
        "label",
        { className: "flex items-center gap-2" },
        h("span", { className: "text-body" }, "Model calls per job"),
        h("input", {
          "aria-label": "Model calls per job",
          type: "number",
          min: 1,
          max: 9999,
          defaultValue: firm.model_calls_per_job ?? "",
          onBlur: (e) =>
            e.target.value &&
            Number(e.target.value) !== firm.model_calls_per_job &&
            tell(`set model calls per job ${e.target.value}`)
              .then((answer) => setRefused(LIMITED.test(answer) ? "" : answer))
              .catch((error) => setRefused(error.message))
              .then(reread),
        }),
        h("span", { className: "text-body-sm text-secondary" }, "A job's run stops at this many."),
      ),
      refused && h("p", { className: "m-0 text-body-sm text-danger" }, refused),
    );
  }

  /** Whether the person is an owner or admin of the community, as Buzz's Settings asks before it lists the card. */
  const adminship = (() => {
    let [value, reading] = ["pending", false];
    const listeners = new Set();
    const read = () => {
      if (reading) return;
      reading = true;
      admins()
        .then(
          (keys) => (value = keys.includes(ctx.relay.snapshot().viewer)),
          () => (value = "error"),
        )
        .finally(() => {
          reading = false;
          for (const listener of listeners) listener();
        });
    };
    return {
      snapshot: () => value,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure: () => {
        read();
        return () => {};
      },
    };
  })();
  ctx.settingsCards.register({
    id: "coworkers",
    title: "Coworkers",
    section: "administration",
    visibility: adminship,
    component: Coworkers,
  });

  ctx.agents.register({
    id: "duck",
    title: "duck",
    description: "The coworker your firm made for you, on your firm's own server.",
    icon: ({ size = 16 }) =>
      h(
        "svg",
        { width: size, height: size, viewBox: "7.3 8.2 86 86", "aria-hidden": true },
        h("path", { fill: "currentColor", d: TRACK }),
      ),
    defaults: () => ({ config: { coworker: "" } }),
    summary: () => "On your firm's server",
    Create,
    tabs: [
      { id: "todos", title: "To-dos", component: ToDos },
      { id: "preferences", title: "Preferences", component: Preferences },
    ],
    remote: {
      // The coworker's key is the one duck's offer names; nothing is sent until Buzz has signed the claim.
      async provision({ config, picture }) {
        if (!config?.coworker) throw new Error("Choose the coworker your firm made for you.");
        const key = (await offers(await duck())).get(config.coworker);
        if (!key) throw new Error("duck never offered you that coworker.");
        if (picture) pictures.set(key, picture);
        return { pubkey: key, ...(picture && { picture }) };
      },
      // Buzz's ownership proof, sent alone, is the claim duck takes.
      async activate({ pubkey, name, auth }) {
        await ask(JSON.stringify(auth), YOURS);
        await profile({ pubkey, name, picture: pictures.get(pubkey) });
      },
      profile,
      // duck stops it and keeps its memory; claiming it again brings it back.
      remove: async ({ pubkey }) => ask(`remove ${await nameOf(pubkey)}`, STOPPED),
    },
  });
}

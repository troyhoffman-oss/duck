import { join } from "node:path";
import type { Buzz, BuzzEvent, Writer } from "./buzz";

/** What Buzz's host calls on a hosted agent type (buzz-app src/features/agents/service.ts:1160-1230). */
type Remote = {
  provision(input: object): Promise<{ pubkey: string; picture?: string }>;
  activate(input: object): Promise<void>;
  profile(input: object): Promise<void>;
  remove(input: object): Promise<void>;
};
type AgentType = {
  id: string;
  title: string;
  defaults(): { config: object };
  Create: (props: object) => unknown;
  remote: Remote;
  tabs: { title: string; component: (props: object) => unknown }[];
};
/** What Buzz's Settings takes from a plugin's card (buzz-app src/features/settings/service.ts:10-35). */
type Card = {
  title: string;
  section?: string;
  visibility?: { snapshot(): unknown; subscribe(listener: () => void): () => void; ensure(): () => void };
  component: (props: object) => unknown;
};
/** What a component drew: an element, its props and what is in it. */
type Drawn = { type: unknown; props: Record<string, unknown>; children: unknown[] };

/** Each line of words `node` shows: an element that holds only words is one line. */
function lines(node: unknown): string[] {
  if (!node || typeof node !== "object") return node || node === 0 ? [String(node)] : [];
  const { children } = node as Drawn;
  if (children.every((c) => typeof c !== "object" || c === null))
    return [children.filter(Boolean).join("")].filter(Boolean);
  return children.flatMap(lines);
}
/** Each element in `node` that `fits`, outermost first. */
function each(node: unknown, fits: (drawn: Drawn) => boolean): Drawn[] {
  if (!node || typeof node !== "object") return [];
  const drawn = node as Drawn;
  return [...(fits(drawn) ? [drawn] : []), ...drawn.children.flatMap((c) => each(c, fits))];
}
/** What `drawn` shows: its lines, those of what it folds away, and its controls by their labels. */
function shows(drawn: unknown) {
  const controls = each(drawn, (d) => "aria-label" in d.props).map((d) => [d.props["aria-label"], d.props]);
  return {
    lines: lines(drawn),
    folded: lines(each(drawn, (d) => d.type === "details")[0]),
    controls: Object.fromEntries(controls) as Record<string, Record<string, unknown>>,
  };
}

/**
 * Enough of React to draw the plugin's components as Buzz's React does, to read what they show: elements,
 * state, and effects, run once when a component is first drawn.
 */
function react() {
  let [hooks, at] = [[] as unknown[], 0];
  const slot = (first: () => unknown) => {
    const i = at++;
    if (!(i in hooks)) hooks[i] = first();
    return i;
  };
  return {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props: props ?? {},
      children: children.flat(),
    }),
    useState(initial: unknown) {
      const i = slot(() => initial);
      return [hooks[i], (value: unknown) => (hooks[i] = value)];
    },
    useEffect: (effect: () => void) => slot(() => effect()),
    /** Draws `component` with `props`, anew where `fresh`, as when it is opened. */
    draw(component: (props: object) => unknown, props: object, fresh: boolean) {
      if (fresh) hooks = [];
      at = 0;
      return component(props);
    },
  };
}

/**
 * duck's plugin, plugin/plugin.js as it ships, loaded for `who` with a stand-in for what Buzz's desktop hands it:
 * their relay session, which reads and writes as them in the test's Buzz, and the agents service, which keeps
 * the agent type it registers and calls it in the order Buzz's code does. Buzz's own code, React and the New
 * agent dialog are not here: what the plugin draws is read as its words, and how it looks is seen only in Buzz.
 * The session writes only what Buzz's own artifact writer does, an artifact (kind 45010) signed as `who`; the
 * test's relay, Buzz's own at the pinned commit, decides who reads and writes each channel.
 */
export async function loadPlugin(buzz: Buzz, who: Writer) {
  const types: AgentType[] = [];
  const agents: { pubkey: string }[] = [];
  const relayAuthor = await buzz.relayKey();
  // Buzz's desktop reads over the relay's HTTP query, which pages with a limit; on its socket, a read of
  // current artifacts is a sync, which takes none.
  const read = (filters: Record<string, unknown>[]): Promise<BuzzEvent[]> =>
    buzz.query(
      who,
      filters.map(({ limit, ...f }) => ("artifact" in f ? f : { limit, ...f })),
    );
  const session = {
    viewer: buzz.keys[who],
    relayAuthor,
    read,
    // The relay's own answer, fresh, as Buzz reads its config artifacts (buzz-app src/features/relay/session.ts:2707-2716).
    snapshotRead: (filters: Record<string, unknown>[], _settings: { signal?: AbortSignal }) => read(filters),
    channels: {
      /**
       * NIP-CL: the channels `creator` made labelled `label`, oldest first, from the relay's own metadata, as
       * Buzz's findLabeled reads them (buzz-app src/features/relay/store.ts:3195-3245).
       */
      async findLabeled({ creator, label }: { creator: string; label: string }) {
        const found = await read([
          { kinds: [39000], authors: [relayAuthor], "#P": [creator], "#t": [label] },
        ]);
        const tag = (event: BuzzEvent, name: string) => event.tags.find((t) => t[0] === name)?.[1];
        return found
          .filter((c) => tag(c, "P") === creator && c.tags.some(([t, v]) => t === "t" && v === label))
          .map((c) => ({
            id: tag(c, "d"),
            channelType: tag(c, "t"),
            creator,
            createdAt: Number(tag(c, "created_at")),
          }))
          .sort((a, b) => a.createdAt - b.createdAt);
      },
    },
    // Buzz's artifact writer signs only an artifact, as the person (buzz-app src/features/relay/native.ts:620-646).
    configArtifactWriter: {
      kinds: [45010],
      async sign(template: { kind: number; tags: string[][]; content: string }) {
        if (template.kind !== 45010) throw new Error("Not an artifact");
        return buzz.sign(who, template.kind, template.tags, template.content);
      },
      publish: (event: BuzzEvent) => buzz.publish(who, event),
    },
  };
  // A path in a variable, since the plugin is plain JavaScript that the type checker does not read.
  const file = join(import.meta.dir, "..", "..", "plugin", "plugin.js");
  const plugin = await import(file);
  const host = react();
  const cards: Card[] = [];
  plugin.apply({
    react: host,
    relay: { snapshot: () => ({ viewer: session.viewer, session }) },
    agents: { register: (type: AgentType) => types.push(type), snapshot: () => ({ agents }) },
    settingsCards: { register: (card: Card) => cards.push(card) },
  });
  const type = types.find((t) => t.id === "duck");
  if (!type) throw new Error("duck's plugin registered no duck agent type");
  const [community, signal] = [buzz.url, new AbortController().signal];
  /**
   * What `component`, drawn with `props`, shows once it has read, opened anew until its lines fit `fits`, for up
   * to 60 s (see `shows`), and what changes one of its controls.
   */
  async function opened(
    component: (props: object) => unknown,
    props: object,
    fits: (shown: string[]) => boolean,
  ) {
    for (const end = Date.now() + 60_000; ; await Bun.sleep(1000)) {
      let drawn = host.draw(component, props, true);
      for (
        let read = Date.now() + 10_000;
        Date.now() < read && lines(drawn)[0]?.endsWith("…");
        await Bun.sleep(200)
      )
        drawn = host.draw(component, props, false);
      const shown = shows(drawn);
      const again = () => host.draw(component, props, false);
      if (fits(shown.lines))
        return {
          ...shown,
          /**
           * Changes control `label` to `target`, as a person does, once its change has settled, and returns what
           * it shows then, before it reads again.
           */
          async change(label: string, target: object) {
            const props = shown.controls[label] ?? {};
            const done = (props.onBlur ?? props.onChange) as (e: object) => Promise<unknown>;
            await done({ target });
            return shows(again());
          },
        };
      if (Date.now() > end) throw new Error(`waited 60 s for it to fit: ${shown.lines.join(" / ")}`);
    }
  }
  /**
   * Finishing the setup of agent `pubkey`, which Buzz also retries: the owner's NIP-OA authorization of its
   * key, then activate (service.ts:4428-4451).
   */
  const finish = (pubkey: string, name: string, config: object) =>
    type.remote.activate({
      pubkey,
      name,
      community,
      auth: JSON.parse(buzz.proof(who, pubkey)),
      config,
      signal,
    });
  return {
    type,
    /** What New agent shows for the duck type once it has read (see `opened`). */
    create: (fits: (shown: string[]) => boolean) =>
      opened(type.Create, { config: type.defaults().config, onChange: () => {}, disabled: false }, fits),
    /**
     * Create agent, then Let's go, in New agent for coworker `coworker` with `name` and `picture`: provision,
     * then `finish` (service.ts:4383-4425). Returns what provision did.
     */
    async add(coworker: string, name: string, picture?: string) {
      const config = { ...type.defaults().config, coworker };
      const made = await type.remote.provision({ name, picture, community, config, signal });
      await finish(made.pubkey, name, config);
      agents.push({ pubkey: made.pubkey });
      return made;
    },
    /** Buzz finishing the setup of coworker `coworker`, key `pubkey`, named `name`, again. */
    finish: (coworker: string, pubkey: string, name: string) =>
      finish(pubkey, name, { ...type.defaults().config, coworker }),
    /** Saving a new name and picture for agent `pubkey` (service.ts:5005-5040). */
    edit: (pubkey: string, name: string, picture?: string) =>
      type.remote.profile({ pubkey, community, name, picture, signal }),
    /**
     * What the tab titled `title` on agent `pubkey`'s page shows once it has read, opened anew until its
     * lines fit `fits`, for up to 60 s (see `shows`), and what changes one of its controls.
     */
    async tab(title: string, pubkey: string, fits: (shown: string[]) => boolean) {
      const tab = type.tabs.find((t) => t.title === title);
      if (!tab) throw new Error(`duck's plugin has no ${title} tab`);
      return opened(tab.component, { agent: { pubkey } }, fits);
    },
    /**
     * Whether Settings lists the card titled `title` under Community admin, once its visibility check has
     * answered (settings-sections.ts:124-170, service.ts:59-72): true, false or "error".
     */
    async listed(title: string) {
      const card = cards.find((c) => c.title === title);
      if (card?.section !== "administration") throw new Error(`duck's plugin has no ${title} admin card`);
      const answered = Promise.withResolvers<void>();
      const stop = card.visibility?.subscribe(() => answered.resolve());
      card.visibility?.ensure();
      if (card.visibility?.snapshot() === "pending") await answered.promise;
      stop?.();
      return card.visibility?.snapshot() ?? true;
    },
    /** What the admin card titled `title` shows, which Settings must list (see `listed` and `opened`). */
    async card(title: string, fits: (shown: string[]) => boolean) {
      const seen = await this.listed(title);
      if (seen !== true) throw new Error(`Settings does not list the ${title} card: ${seen}`);
      const card = cards.find((c) => c.title === title) as Card;
      return opened(card.component, { active: () => true }, fits);
    },
    /** Delete for agent `pubkey`, once Buzz has archived it (service.ts:5918-5958). */
    async remove(pubkey: string) {
      await type.remote.remove({ pubkey, community, signal });
      agents.splice(
        agents.findIndex((a) => a.pubkey === pubkey),
        1,
      );
    },
  };
}

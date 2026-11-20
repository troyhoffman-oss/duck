import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A message a person saw in another product, in the archive's shape: the session it was in there and its
 * own id there, whether it came in or went out, when, where, its words, its files' names and, where the
 * source names one, who wrote it.
 */
type Seen = {
  session: string;
  ref: string;
  way: "in" | "out";
  at: string;
  door: string;
  text: string;
  files: string[];
  author?: string;
};

/** What an importer found: what the person saw, and how much of the rest it left out, by reason. */
class Found {
  seen: Seen[] = [];
  skipped = new Map<string, number>();
  skip(reason: string, count = 1) {
    if (count > 0) this.skipped.set(reason, (this.skipped.get(reason) ?? 0) + count);
  }
}

/** An export's time as the archive writes it, or a loud failure naming the field it lacked. */
function at(value: string | number | null | undefined, field: string) {
  if (value === null || value === undefined) throw new Error(`the export has a message with no ${field}`);
  return new Date(value).toISOString();
}

/** The values from the root down to `leaf`, where `up` gives a node's value and its parent's id. */
function branch<T>(leaf: string, up: (id: string) => [T, string | null | undefined] | undefined): T[] {
  const values: T[] = [];
  for (let step = up(leaf); step; step = step[1] ? up(step[1]) : undefined) values.push(step[0]);
  return values.reverse();
}

type ClaudeMessage = {
  uuid: string;
  parent_message_uuid: string;
  sender: string;
  created_at: string;
  content: { type: string; text?: string }[];
  attachments: { file_name: string }[];
  files: { file_name: string }[];
};

/** A claude.ai data export's conversations.json. */
function claude(path: string, found: Found) {
  for (const c of JSON.parse(readFileSync(path, "utf8")) as {
    uuid: string;
    chat_messages: ClaudeMessage[];
  }[]) {
    if (c.chat_messages.length === 0) continue;
    const by = new Map(c.chat_messages.map((m) => [m.uuid, m]));
    // The export marks no branch as the one shown: the person ended on the one their latest message is on.
    const last = c.chat_messages.reduce((a, b) =>
      Date.parse(b.created_at) >= Date.parse(a.created_at) ? b : a,
    );
    const kept = branch(last.uuid, (id) => {
      const m = by.get(id);
      return m && [m, m.parent_message_uuid];
    });
    found.skip("messages on branches the person left", c.chat_messages.length - kept.length);
    for (const m of kept) {
      for (const b of m.content) if (b.type !== "text") found.skip(`${b.type} blocks`);
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text ?? ""] : [])).join("\n\n");
      const files = [...m.attachments, ...m.files].map((f) => f.file_name);
      if (!text.trim() && files.length === 0) found.skip("messages with no words");
      else
        found.seen.push({
          session: c.uuid,
          ref: m.uuid,
          way: m.sender === "human" ? "in" : "out",
          at: at(m.created_at, "created_at"),
          door: "claude",
          text,
          files,
        });
    }
  }
}

type ChatGptMessage = {
  id: string;
  author: { role: string };
  create_time: number | null;
  content: { content_type: string; parts?: unknown[] };
  recipient: string;
  weight?: number;
  metadata: { is_visually_hidden_from_conversation?: boolean; attachments?: { name: string }[] };
};

/** A ChatGPT data export's conversations.json, or one of its conversations-000.json parts. */
function chatgpt(path: string, found: Found) {
  type Conversation = {
    conversation_id: string;
    current_node: string;
    mapping: Record<string, { message: ChatGptMessage | null; parent?: string | null }>;
  };
  for (const c of JSON.parse(readFileSync(path, "utf8")) as Conversation[]) {
    const kept = branch(c.current_node, (id) => {
      const node = c.mapping[id];
      return node && [node.message, node.parent];
    }).filter((m) => m !== null);
    const all = Object.values(c.mapping).filter((node) => node.message !== null).length;
    found.skip("messages on branches the person left", all - kept.length);
    for (const m of kept) {
      const { role } = m.author;
      const text = (m.content.parts ?? [])
        .map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? "")))
        .filter(Boolean)
        .join("\n");
      const files = (m.metadata.attachments ?? []).map((a) => a.name);
      const reason =
        role !== "user" && role !== "assistant"
          ? `${role} messages`
          : m.recipient !== "all"
            ? "tool calls"
            : m.metadata.is_visually_hidden_from_conversation || m.weight === 0
              ? "hidden messages"
              : !["text", "multimodal_text"].includes(m.content.content_type)
                ? `${m.content.content_type} messages`
                : !text.trim() && files.length === 0
                  ? "messages with no words"
                  : null;
      if (reason) found.skip(reason);
      else
        found.seen.push({
          session: c.conversation_id,
          ref: m.id,
          way: role === "user" ? "in" : "out",
          at: at(m.create_time && m.create_time * 1000, "create_time"),
          door: "chatgpt",
          text,
          files,
        });
    }
  }
}

/**
 * Sources Hermes runs with no person typing (hermes-agent agent/prompt_caching.py, MACHINE_PACED_SOURCES), less
 * `api`, which no Hermes code writes as a session's source.
 */
const MACHINE = new Set(
  `subagent cron oneshot webhook kanban api_server tool batch curator a2a msgraph_webhook
  gateway_hygiene`.split(/\s+/),
);
/** How the rows Hermes writes as the user's own, with none of their words, begin (agent/context_compressor.py). */
const SCAFFOLD =
  /^\s*(\[(System|CONTEXT|PRIOR CONTEXT|IMPORTANT: Background|Your active task list|Planning state preserved|ASYNC DELEGATION|Runtime note)|Cronjob Response:)/;
/** A message the person sent during a run, as Hermes wraps it (agent/prompt_builder.py). */
const STEER = /\[OUT-OF-BAND USER MESSAGE[^\]]*\]([\s\S]*?)\[\/OUT-OF-BAND USER MESSAGE\]/;
/** How Hermes begins a message in a chat people share: its writer's name, after any reply (gateway/run_inbound.py). */
const SENDER = /^(\[Replying to[^\n]*?: "[\s\S]*?"\]\n\n)?\[([^\]\n]+)\] ([\s\S]*)$/;

type HermesRow = {
  id: number;
  role: string;
  content: unknown;
  timestamp: number;
  active: number;
  compacted: number;
  display_kind: string | null;
  display_metadata: unknown;
  _compressed_summary?: unknown;
  tool_calls: unknown;
};

type HermesSession = {
  id: string;
  source: string;
  parent_session_id: string | null;
  chat_type: string | null;
  messages: HermesRow[];
};

/**
 * Hermes's sessions with their rows, read when asked for: from its state.db, the profile folder that holds it, or
 * `hermes sessions export` JSONL.
 */
function* hermesSessions(path: string): Generator<HermesSession> {
  if (path.endsWith(".jsonl")) {
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) yield JSON.parse(line);
    return;
  }
  const db = new Database(statSync(path).isDirectory() ? join(path, "state.db") : path, { readonly: true });
  // A tool's output is most of a store and none of what is loaded, so it is never read.
  const rows = db.query<HermesRow, [string]>(
    `select id, role, case when role in ('user', 'assistant') then content end as content, timestamp, active,
      compacted, display_kind, display_metadata, _compressed_summary, tool_calls is not null as tool_calls
      from messages where session_id = ? order by id`,
  );
  const sessions = db.query<Omit<HermesSession, "messages">, []>(
    "select id, source, parent_session_id, chat_type from sessions order by started_at",
  );
  for (const s of sessions.all())
    yield {
      ...s,
      get messages() {
        return rows.all(s.id);
      },
    };
  db.close();
}

/** The words of a Hermes row: a string, or a list of parts, stored with a marker (hermes_state.py). */
function hermesWords(content: unknown) {
  const parts =
    typeof content === "string" && content.startsWith("\0json:") ? JSON.parse(content.slice(6)) : content;
  return Array.isArray(parts)
    ? parts.map((p) => (typeof p === "string" ? p : (p.text ?? ""))).join("")
    : String(parts ?? "");
}

/**
 * A Hermes agent's sessions with people: its state.db, or a session export. Sessions Hermes chains, each going on
 * from the one before after a reset or a compaction, are one conversation, named for the first.
 */
function hermes(path: string, found: Found) {
  const roots = new Map<string, string>();
  // Compaction keeps a copy of the newest rows, which Hermes shows once (hermes_state_timeline.py).
  const shown = new Set<string>();
  for (const s of hermesSessions(path)) {
    const root = roots.get(s.parent_session_id ?? "") ?? s.parent_session_id ?? s.id;
    roots.set(s.id, root);
    if (MACHINE.has(s.source)) {
      found.skip(`${s.source} sessions, run with no person`);
      continue;
    }
    for (const m of s.messages) {
      const raw = hermesWords(m.content).trim();
      const steer = m.display_kind === "steer" ? STEER.exec(raw) : null;
      if (m.display_kind === "steer" && !steer)
        throw new Error("the export has a steer row with no OUT-OF-BAND USER MESSAGE marker");
      const text = steer?.[1]?.trim() ?? raw;
      const meta =
        typeof m.display_metadata === "string" ? JSON.parse(m.display_metadata) : m.display_metadata;
      const copy = JSON.stringify([root, m.role, m.timestamp, text]);
      const reason =
        m.role === "tool" || (m.role === "assistant" && !text && m.tool_calls)
          ? "tool calls and results"
          : m.role !== "user" && m.role !== "assistant"
            ? `${m.role} rows`
            : !(m.active || m.compacted)
              ? "rows undone or replaced"
              : m._compressed_summary
                ? "compaction summaries"
                : (m.display_kind && !steer) ||
                    meta?.model_only ||
                    (m.role === "user" && !steer && SCAFFOLD.test(text))
                  ? "hidden rows and Hermes's own notices"
                  : !text
                    ? "rows with no words"
                    : shown.has(copy)
                      ? "copies compaction kept"
                      : null;
      if (reason) found.skip(reason);
      else {
        shown.add(copy);
        const by = m.role === "user" && s.chat_type && s.chat_type !== "dm" ? SENDER.exec(text) : null;
        found.seen.push({
          session: root,
          ref: `${s.id}/${m.id}`,
          way: m.role === "user" ? "in" : "out",
          at: at(m.timestamp * 1000, "timestamp"),
          door: s.source,
          text: by ? `${by[1] ?? ""}${by[3]}` : text,
          files: [],
          author: by?.[2],
        });
      }
    }
  }
}

/** What an earlier product kept besides conversations, by kind, as globs in the folder it keeps them in. */
const MATERIAL: Record<string, string[]> = { hermes: ["memories/*.md", "cron/jobs.json"] };

/**
 * Copies what the earlier product of `kind` remembered and scheduled, from its folder at `path`, into `folder`
 * under the kind's name, and says what it copied. A file already there is the coworker's own and is left as it is.
 */
export function importMaterial(kind: string, path: string, folder: string): string[] {
  const globs = MATERIAL[kind];
  if (!globs || !statSync(path).isDirectory()) return [];
  const copied = globs
    .flatMap((glob) => [...new Bun.Glob(glob).scanSync(path)])
    .filter((file) => {
      const to = join(folder, kind, file);
      if (existsSync(to)) return false;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(join(path, file), to);
      return true;
    });
  return copied.length > 0 ? [`copied ${copied.sort().join(", ")} to ${join(folder, kind)}`] : [];
}

/** One importer per source, by the kind `duck import` names. */
const IMPORTERS: Record<string, (path: string, found: Found) => void> = { claude, chatgpt, hermes };

/**
 * Loads the export of `kind` at `path` into the coworker's archive in `db`, and says what it loaded and what
 * it left out. A message loaded before is left as it is.
 */
export function importHistory(db: Database, kind: string, path: string): string[] {
  const importer = IMPORTERS[kind];
  if (!importer) throw new Error(`duck imports ${Object.keys(IMPORTERS).join(", ")}; not "${kind}"`);
  const found = new Found();
  importer(path, found);
  const add = db.query(
    `insert into messages (session, ref, way, at, door, text, files, source, author)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing returning id`,
  );
  const loaded = db.transaction(() =>
    found.seen.filter((m) =>
      add.get(m.session, m.ref, m.way, m.at, m.door, m.text, JSON.stringify(m.files), kind, m.author ?? null),
    ),
  )();
  found.skip("messages already in the archive", found.seen.length - loaded.length);
  const times = loaded.map((m) => m.at).sort();
  const minute = (t = "") => `${t.slice(0, 16).replace("T", " ")} UTC`;
  return [
    `loaded ${loaded.length} messages in ${new Set(loaded.map((m) => m.session)).size} sessions${
      times.length > 0 ? `, from ${minute(times[0])} to ${minute(times.at(-1))}` : ""
    }`,
    ...[...found.skipped].map(([reason, count]) => `skipped ${count} ${reason}`),
  ];
}

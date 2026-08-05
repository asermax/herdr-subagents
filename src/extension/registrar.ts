import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

// Agent-resolution role of the pi extension.
//
// `.claude/agents/*.md` is the canonical agent-definition format for both
// harnesses; pi does not scan it natively. This module resolves those files on
// pi, applies the field mapping, and exposes a registrar that `pi-cc-plugins`
// (or any other extension) feeds over the `pi.events` bus. No conversion step:
// the files are read as-is.
//
// The extension reads pi-native directories (`.pi/agents`, `.claude/agents`)
// directly; bus registrations replace per (source, namespace) rather than
// accumulating, so a session switch drops the previous project's agents with no
// staleness.

/** Where an agent definition came from, ranked low → high. */
const SOURCE_RANK = {
  user: 0,
  package: 1,
  project: 2,
} as const;

type Source = keyof typeof SOURCE_RANK;

/** The agent record after field mapping — the shape pi consumes. */
export interface AgentRecord {
  name: string;
  description: string;
  source: Source;
  namespace: string;
  path: string;
  thinking?: string;
  turnBudget?: { maxTurns: number };
  skills?: string[];
  // The Markdown body below the frontmatter is the agent's system prompt in
  // the Claude format; appended at launch (systemPromptMode: "append").
  systemPrompt?: string;
  // Fixed application defaults: the Claude format has no toggles for
  // these, so they are constant per agent.
  systemPromptMode: "append";
  inheritProjectContext: true;
  inheritSkills: true;
}

export interface ResolveOptions {
  /** Project working directory. */
  cwd: string;
  /** User home; defaults to os.homedir(). */
  userDir?: string;
}

export interface ResolveResult {
  agents: AgentRecord[];
  warnings: string[];
}

const CLAUDE_AGENTS = join(".claude", "agents");
const PI_AGENTS = join(".pi", "agents");

/**
 * Resolve agent definitions from pi-native directories under the project cwd
 * and the user home. Precedence (low → high):
 *   user/.claude/agents < user/.pi/agents < project/.claude/agents < project/.pi/agents
 * Same name in the SAME directory warns; first wins. Same name across
 * directories is resolved by precedence, silently.
 */
export function resolveAgents(options: ResolveOptions): ResolveResult {
  const userDir = options.userDir ?? homedir();
  const warnings: string[] = [];

  // Lowest rank first; later entries overwrite earlier ones of the same name.
  const scanOrder: Array<{ dir: string; source: Source }> = [
    { dir: join(userDir, CLAUDE_AGENTS), source: "user" },
    { dir: join(userDir, PI_AGENTS), source: "user" },
    { dir: join(options.cwd, CLAUDE_AGENTS), source: "project" },
    { dir: join(options.cwd, PI_AGENTS), source: "project" },
  ];

  const byName = new Map<string, AgentRecord>();
  for (const { dir, source } of scanOrder) {
    if (!existsSync(dir)) continue;
    const loaded = loadDirectory(dir, source, "");
    for (const warning of loaded.warnings) warnings.push(warning);
    for (const agent of loaded.agents) {
      // Higher-rank directories overwrite; same rank is already "first wins"
      // inside loadDirectory. Across directories the last writer wins, and
      // scanOrder is sorted low → high, so the highest-rank definition lands.
      byName.set(agent.name, agent);
    }
  }

  return { agents: [...byName.values()], warnings };
}

interface LoadResult {
  agents: AgentRecord[];
  warnings: string[];
}

/** Load every `*.md` in one directory, applying same-name-first-wins. */
function loadDirectory(dir: string, source: Source, namespace: string): LoadResult {
  const agents: AgentRecord[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  let entries: string[] = [];
  try {
    entries = readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return { agents, warnings };
  }

  for (const name of entries) {
    const path = join(dir, name);
    let isFile = false;
    try {
      isFile = statSync(path).isFile();
    } catch {
      continue;
    }
    if (!isFile) continue;

    const parsed = parseAgentFile(path);
    if (!parsed) continue;

    if (seen.has(parsed.record.name)) {
      warnings.push(
        `agent "${parsed.record.name}" defined more than once in ${dir}; keeping the first`,
      );
      continue;
    }
    seen.add(parsed.record.name);
    agents.push({ ...parsed.record, source, namespace });
  }

  return { agents, warnings };
}

/** A bus registration payload: absolute paths + namespace + source. */
export interface RegisterPayload {
  version: 1;
  paths: string[];
  namespace: string;
  source: Source;
}

interface ParsedFile {
  record: Omit<AgentRecord, "source" | "namespace">;
}

/** Parse one Claude-format file into a mapped agent record (minus origin). */
function parseAgentFile(path: string): ParsedFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(raw);
  const name = stringField(frontmatter, "name");
  const description = stringField(frontmatter, "description");
  // Files require name and description (research §2.1, mirroring pi-subagents).
  if (!name || !description) return null;

  const record: Omit<AgentRecord, "source" | "namespace"> = {
    name,
    description,
    path,
    systemPromptMode: "append",
    inheritProjectContext: true,
    inheritSkills: true,
  };

  const effort = stringField(frontmatter, "effort");
  if (effort) record.thinking = effort;

  const maxTurns = numberField(frontmatter, "maxTurns");
  if (maxTurns !== undefined) record.turnBudget = { maxTurns };

  const skills = listField(frontmatter, "skills");
  if (skills.length > 0) record.skills = skills;

  if (body.length > 0) record.systemPrompt = body;

  // Dropped silently: tools, disallowedTools, model, mcpServers,
  // hooks, memory, background, isolation, color. They are parsed and ignored.
  return { record };
}

/**
 * The registrar: a name → record map, plus replace-per-(source,namespace)
 * storage for bus registrations. Native directory resolution (resolveAgents)
 * and bus registrations merge at resolve() time under the precedence rank.
 */
export interface Registrar {
  /** All currently-known agents, precedence-merged, highest rank per name. */
  list(): AgentRecord[];
  /** Resolve a single agent by name; namespaced agents need the `ns:name` form. */
  resolve(name: string): AgentRecord | undefined;
  /** Replace the agents for one (source, namespace) key. */
  register(payload: RegisterPayload): void;
}

const KEY_SEP = "\u0000";

function busKey(source: Source, namespace: string): string {
  return `${SOURCE_RANK[source]}${KEY_SEP}${namespace}`;
}

export function createRegistrar(): Registrar {
  // source → namespace → name → record. Replacing a (source, namespace) drops
  // the previous set entirely (no staleness on session switch).
  const bus = new Map<string, Map<string, AgentRecord>>();

  return {
    list(): AgentRecord[] {
      return mergeByRank(bus);
    },

    resolve(name: string): AgentRecord | undefined {
      return mergeByRank(bus).find((a) => qualifiedName(a) === name);
    },

    register(payload: RegisterPayload): void {
      const key = busKey(payload.source, payload.namespace);
      const next = new Map<string, AgentRecord>();
      for (const raw of payload.paths) {
        const path = isAbsolute(raw) ? raw : resolve(raw);
        const parsed = parseAgentFile(path);
        if (!parsed) continue;
        const agent: AgentRecord = {
          ...parsed.record,
          source: payload.source,
          namespace: payload.namespace,
        };
        // First wins within a (source, namespace) batch.
        const qualified = qualifiedName(agent);
        if (next.has(qualified)) continue;
        next.set(qualified, agent);
      }
      bus.set(key, next);
    },
  };
}

/** Merge every bus (source, namespace) batch by precedence rank, highest wins. */
function mergeByRank(bus: Map<string, Map<string, AgentRecord>>): AgentRecord[] {
  const batches = [...bus.values()].map((m) => [...m.values()]);
  // Key on the qualified name: a standalone `reviewer` and a plugin's
  // `my-plugin:reviewer` are distinct identities and must not shadow each
  // other (plugin-shipped agents are namespaced). Only agents that
  // share a qualified name compete on the source precedence rank.
  const byName = new Map<string, AgentRecord>();
  for (const batch of batches) {
    for (const agent of batch) {
      const key = qualifiedName(agent);
      const existing = byName.get(key);
      // Higher rank wins; on equal rank the later batch overwrites, so the
      // last-seen definition of a name lands.
      if (!existing || rankOf(agent) >= rankOf(existing)) {
        byName.set(key, agent);
      }
    }
  }
  return [...byName.values()];
}

function rankOf(agent: AgentRecord): number {
  return SOURCE_RANK[agent.source];
}

/** Bare name for standalone agents, `namespace:name` for plugin-shipped ones. */
function qualifiedName(agent: { name: string; namespace: string }): string {
  return agent.namespace ? `${agent.namespace}:${agent.name}` : agent.name;
}

// --- frontmatter (focused YAML-subset parser for the Claude agent format) ---

type Frontmatter = Record<string, unknown>;

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const frontmatter: Frontmatter = {};
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match || match[1] === undefined) return { frontmatter, body: "" };

  const lines = match[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon === -1) {
      i += 1;
      continue;
    }

    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (rest !== "") {
      frontmatter[key] = parseScalar(rest);
      i += 1;
      continue;
    }

    // Block: collect following indented lines (a list or a nested map).
    const block = collectBlock(lines, i + 1);
    if (block.length > 0) {
      frontmatter[key] = parseBlock(block);
      i += 1 + block.length;
    } else {
      frontmatter[key] = null;
      i += 1;
    }
  }

  // The body after the closing fence is the agent's system prompt.
  const body = raw.slice(match[0].length).replace(/^\r?\n+/, "").trim();
  return { frontmatter, body };
}

/** Collect consecutive indented lines following a `key:` header. */
function collectBlock(lines: string[], start: number): string[] {
  const out: string[] = [];
  for (let j = start; j < lines.length; j += 1) {
    const line = lines[j]!;
    if (line.trim() === "") {
      out.push(line);
      continue;
    }
    if (/^\s+/.test(line)) {
      out.push(line);
      continue;
    }
    break;
  }
  // Trim trailing blank lines.
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return out;
}

function parseBlock(lines: string[]): unknown {
  // List if every non-blank line is a `- item`.
  if (lines.every((l) => l.trim() === "" || l.trim().startsWith("-"))) {
    return lines
      .map((l) => l.trim().replace(/^-\s*/, ""))
      .filter((v) => v !== "")
      .map((v) => parseScalar(v));
  }
  return lines.map((l) => l.trim()).filter((l) => l !== "");
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (/^-?\d+$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function stringField(fm: Frontmatter, key: string): string | undefined {
  const value = fm[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(fm: Frontmatter, key: string): number | undefined {
  const value = fm[key];
  return typeof value === "number" ? value : undefined;
}

function listField(fm: Frontmatter, key: string): string[] {
  const value = fm[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

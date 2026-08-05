import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Agent-resolution role of the pi extension.
//
// `.claude/agents/*.md` is the canonical agent-definition format for both
// harnesses; pi does not scan it natively. This module resolves those files on
// pi, applies the field mapping, and returns a list that `before_agent_start`
// looks up by name. pi-cc-plugins (or any agent source) writes converted agents
// into `.pi/agents/` — this scanner reads them directly. No event bus, no
// coupling: the filesystem is the shared medium.

/** Where an agent definition came from, ranked low → high. */
type Source = "user" | "project";

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
 * and the user home. The `.pi/agents` directories are scanned RECURSIVELY so
 * agents written by pi-cc-plugins into subdirectories (e.g. `cc-plugins/`) are
 * discovered. Precedence (low → high, last writer wins):
 *   user/.claude/agents < user/.pi/agents < project/.claude/agents < project/.pi/agents
 * Same name in the SAME directory tree warns; first wins. Same name across
 * directories is resolved by precedence, silently.
 */
export function resolveAgents(options: ResolveOptions): ResolveResult {
  const userDir = options.userDir ?? homedir();
  const warnings: string[] = [];

  // Lowest rank first; later entries overwrite earlier ones of the same
  // qualified name.
  const scanOrder: Array<{ dir: string; source: Source }> = [
    { dir: join(userDir, CLAUDE_AGENTS), source: "user" },
    { dir: join(userDir, PI_AGENTS), source: "user" },
    { dir: join(options.cwd, CLAUDE_AGENTS), source: "project" },
    { dir: join(options.cwd, PI_AGENTS), source: "project" },
  ];

  const byName = new Map<string, AgentRecord>();
  for (const { dir, source } of scanOrder) {
    if (!existsSync(dir)) continue;
    const loaded = loadDirectory(dir, source);
    for (const warning of loaded.warnings) warnings.push(warning);
    for (const agent of loaded.agents) {
      byName.set(qualifiedName(agent), agent);
    }
  }

  return { agents: [...byName.values()], warnings };
}

/**
 * Resolve a single agent by name from a resolved list. Tries the qualified name
 * (`namespace:name`, e.g. `superpowers:documentation-searcher`) first, then
 * falls back to a bare name match.
 */
export function resolveAgentByName(
  agents: AgentRecord[],
  name: string,
): AgentRecord | undefined {
  return agents.find((a) => qualifiedName(a) === name) ?? agents.find((a) => a.name === name);
}

interface LoadResult {
  agents: AgentRecord[];
  warnings: string[];
}

/** Recursively collect every `*.md` file path under `dir` (sorted, stable). */
function walkMdFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const path = join(dir, name);
    let st: { isDirectory(): boolean; isFile(): boolean };
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkMdFiles(path, out);
    } else if (st.isFile() && name.endsWith(".md")) {
      out.push(path);
    }
  }
  return out;
}

/** Load every `*.md` in one directory tree, applying same-name-first-wins. */
function loadDirectory(dir: string, source: Source): LoadResult {
  const agents: AgentRecord[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const path of walkMdFiles(dir)) {
    const parsed = parseAgentFile(path);
    if (!parsed) continue;

    const agent: AgentRecord = { ...parsed, source };
    const qname = qualifiedName(agent);
    if (seen.has(qname)) {
      warnings.push(`agent "${qname}" defined more than once in ${dir}; keeping the first`);
      continue;
    }
    seen.add(qname);
    agents.push(agent);
  }

  return { agents, warnings };
}

/** Parse one agent-definition file into a mapped record (minus source). */
function parseAgentFile(path: string): Omit<AgentRecord, "source"> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(raw);
  const name = stringField(frontmatter, "name");
  const description = stringField(frontmatter, "description");
  if (!name || !description) return null;

  // The `package` field (written by pi-cc-plugins' converter) namespaces the
  // agent: `superpowers:documentation-searcher`. Absent → bare name.
  const namespace = stringField(frontmatter, "package") ?? "";

  const record: Omit<AgentRecord, "source"> = {
    name,
    description,
    namespace,
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
  // hooks, memory, background, isolation, color, systemPromptMode,
  // inheritProjectContext, inheritSkills (pi-subagents converter fields).
  return record;
}

/** Bare name for standalone agents, `namespace:name` for namespaced ones. */
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

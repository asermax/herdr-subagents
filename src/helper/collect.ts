import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentSnapshot, HerdrClient } from "./herdr-types.js";
import type { Registry } from "./registry.js";

// collect: read the child's last assistant message from its own session log
// and return it as a structured payload. The child does nothing for it —
// collection is entirely parent-side (ADR-0002).
//
// agent_session on the snapshot is a `.jsonl` path on pi and a session uuid on
// claude. The transcript format differs per harness; both are read here.

export type CollectStatus = "idle" | "working" | "blocked" | "done" | "gone";
// Terminal statuses the payload reports after a wake: done | blocked | gone.
// `blocked` is non-terminal and benign. idle/working appear only if collect is
// called mid-work before any wake.

export interface CollectPayload {
  pane_id: string;
  label: string;
  agent: string;
  status: CollectStatus;
  // Present when the child reached a terminal state. Absent on `blocked`.
  message?: string;
  // `ask: true` when the last assistant message wraps a <subagent-ask> tag — a
  // question (the parent replies, does not close). Absent/undefined = result.
  ask?: boolean;
  error?: string;
}

export interface CollectDeps {
  client: HerdrClient;
  registry: Registry;
  // Bounds the claude-transcript-lag retry loop.
  transcriptRetryMs?: number;
  transcriptAttempts?: number;
  // Read a file as text; injected so tests can feed transcripts.
  readText?: (path: string) => string;
  // Resolve a claude session uuid to its transcript path. Injected so tests
  // can stub the projects-tree lookup.
  resolveClaudeSession?: (uuid: string) => string | undefined;
}

const SUBAGENT_ASK = "<subagent-ask>";

export async function collectChild(
  paneId: string,
  deps: CollectDeps,
): Promise<CollectPayload> {
  const { client, registry } = deps;
  const readText = deps.readText ?? defaultReadText;
  const resolveClaude = deps.resolveClaudeSession ?? defaultResolveClaudeSession;
  const retryMs = deps.transcriptRetryMs ?? 300;
  const attempts = deps.transcriptAttempts ?? 6;

  const entry = await registry.get(paneId);
  if (!entry) {
    return {
      pane_id: paneId,
      label: "",
      agent: "",
      status: "gone",
      error: `no child tracked for pane ${paneId}`,
    };
  }

  const base: CollectPayload = {
    pane_id: paneId,
    label: entry.label,
    agent: entry.agent,
    status: normalizeStatus(entry.status),
  };

  // status reflects herdr's agent state, not task success. Read the snapshot to
  // get the live status + agent_session.
  const snap = await client.agentGet(paneId);
  if (!snap) {
    return { ...base, status: "gone", error: `pane ${paneId} no longer resolves` };
  }
  const status = normalizeStatus(snap.agent_status);
  const payload: CollectPayload = { ...base, status };
  if (status === "blocked") {
    // Non-terminal and benign: the child is still working or waiting on a
    // human. No message to extract.
    return payload;
  }

  const session = snap.agent_session;
  if (!session) {
    return { ...payload, error: "agent has no agent_session recorded" };
  }

  const transcriptPath =
    session.kind === "path"
      ? session.value
      : resolveClaude(session.value);
  if (!transcriptPath) {
    return { ...payload, error: `cannot resolve claude session ${session.value}` };
  }

  // Claude's transcript is written asynchronously and can lag. Verify the last
  // entry is a complete assistant message and retry briefly.
  const message = await readLastAssistantMessage(
    transcriptPath,
    session.kind,
    readText,
    retryMs,
    attempts,
  );
  if (message === undefined) {
    return { ...payload, error: "transcript has no complete assistant message" };
  }
  payload.message = message;
  payload.ask = message.includes(SUBAGENT_ASK);
  await registry.setStatus(paneId, snap.agent_status);
  return payload;
}

function normalizeStatus(status: AgentSnapshot["agent_status"]): CollectStatus {
  // `unknown` reads as `gone` for the payload: detection lost.
  if (status === "unknown") return "gone";
  return status;
}
// Extract the last assistant message from a transcript, retrying on claude
// when the last entry is incomplete (lagging async write). Returns undefined
// when no complete assistant message exists after all attempts.
async function readLastAssistantMessage(
  path: string,
  kind: "path" | "id",
  readText: (p: string) => string,
  retryMs: number,
  attempts: number,
): Promise<string | undefined> {
  for (let i = 0; i < attempts; i++) {
    const text = readText(path);
    const msg = kind === "path" ? lastPiAssistant(text) : lastClaudeAssistant(text);
    if (msg !== undefined) return msg;
    await sleep(retryMs);
  }
  return undefined;
}

// pi session log: newline-delimited JSON. Entries have `type: "message"` with
// `message.role` and `message.content[].text`. The last assistant message is
// the last message entry whose role is assistant with a text block.
function lastPiAssistant(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    const line = lines[i];
    if (line === undefined) continue;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const t = extractText(entry.message.content);
      if (t !== undefined) return t;
    }
  }
  return undefined;
}

// claude transcript: newline-delimited JSON. Assistant entries have
// `message.stop_reason` set when complete (mid-stream entries carry
// `stop_reason: null`). We require a complete assistant message — the lagging
// async write can leave a mid-stream entry as the last line.
function lastClaudeAssistant(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: {
      type?: string;
      message?: {
        role?: string;
        stop_reason?: string | null;
        content?: unknown;
      };
    };
    const line = lines[i];
    if (line === undefined) continue;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "assistant" && entry.message?.role !== "assistant") continue;
    // A complete message has a non-null stop_reason. Mid-stream entries lag.
    if (entry.message?.stop_reason === null) continue;
    const t = extractText(entry.message?.content);
    if (t !== undefined) return t;
  }
  return undefined;
}

function extractText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const texts = content
    .filter((b): b is { type: "text"; text: string } => isTextBlock(b))
    .map((b) => b.text);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function isTextBlock(b: unknown): b is { type: "text"; text: string } {
  return (
    typeof b === "object" && b !== null && (b as { type?: string }).type === "text"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultReadText(path: string): string {
  return readFileSync(path, "utf8");
}

function defaultResolveClaudeSession(uuid: string): string | undefined {
  // claude stores transcripts under ~/.claude/projects/<project>/<uuid>.jsonl.
  // herdr records a claude child's session as { kind: "id", value: "<uuid>" }
  // with NO path (unlike pi's { kind: "path", value: ".../x.jsonl" }), and the
  // child's own Stop hook — the path that would carry the transcript — was
  // deliberately deleted (ADR-0002 makes collection parent-side). So the helper
  // does not know the child's cwd and must scan the projects tree for the uuid.
  // A herdr-side `agent_session_path` for claude would remove this scan.
  const projectsRoot = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsRoot)) return undefined;
  for (const dir of readdirSync(projectsRoot)) {
    const candidate = join(projectsRoot, dir, `${uuid}.jsonl`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
}

// `wait`: blocks until the child reaches a terminal state (done|gone). `blocked`
// is non-terminal and benign — wait does NOT return on it. Speaks the socket.
//
// herdr's `done` persists until acknowledged (focus or the next prompt), so a
// child that is *already* `done` from a previous turn would resolve the wait
// instantly on a stale `done`. To distinguish "already done" from "just
// finished," capture the pre-wait `state_change_seq` and pass it as `fromSeq`:
// the lingering `done` (seq at or below the captured value) is filtered
// client-side, and only a genuinely new transition resolves. Mirrors
// sendPromptWithDelivery in spawn.ts.
export async function waitChild(
  paneId: string,
  client: HerdrClient,
  timeoutMs = 0,
): Promise<AgentSnapshot> {
  const before = await client.agentGet(paneId);
  const fromSeq = before?.state_change_seq ?? 0;
  return client.waitForStatus(paneId, ["done", "unknown"], {
    timeoutMs: timeoutMs || 3_600_000,
    fromSeq,
  });
}

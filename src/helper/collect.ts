import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentSnapshot, AgentStatus, HerdrClient } from "./herdr-types.js";
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
    // Nothing to extract — the child is stalled on a dialog, mid-turn. Ack it:
    // the parent has now been told, so a wait it arms next watches for the
    // child RESUMING rather than firing on this same block (ADR-0008).
    if (snap.state_change_seq !== undefined) {
      await registry.setAcked(paneId, snap.state_change_seq, "blocked");
    }
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
  // The parent has now seen this state: ack it so a wait armed afterwards
  // waits for the NEXT turn instead of firing on this one again (ADR-0008).
  if (snap.state_change_seq !== undefined) {
    await registry.setAcked(paneId, snap.state_change_seq, snap.agent_status);
  }
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

type ParsedEntry = {
  type?: string;
  message?: { role?: string; stop_reason?: string | null; content?: unknown };
};

// Shared skeleton for the two transcript formats: newline-delimited JSON,
// scanned newest-first for the first entry whose assistant text resolves.
function lastAssistantMatching(
  text: string,
  match: (entry: ParsedEntry) => string | undefined,
): string | undefined {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    let entry: ParsedEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const extracted = match(entry);
    if (extracted !== undefined) return extracted;
  }
  return undefined;
}

// pi session log: newline-delimited JSON. Entries have `type: "message"` with
// `message.role` and `message.content[].text`. The last assistant message is
// the last message entry whose role is assistant with a text block.
function lastPiAssistant(text: string): string | undefined {
  return lastAssistantMatching(text, (entry) =>
    entry.type === "message" && entry.message?.role === "assistant"
      ? extractText(entry.message.content)
      : undefined,
  );
}

// claude transcript: newline-delimited JSON. Assistant entries have
// `message.stop_reason` set when complete (mid-stream entries carry
// `stop_reason: null`). We require a complete assistant message — the lagging
// async write can leave a mid-stream entry as the last line.
function lastClaudeAssistant(text: string): string | undefined {
  return lastAssistantMatching(text, (entry) => {
    // accept entries typed assistant OR role-tagged assistant (transcript variants)
    if (entry.type !== "assistant" && entry.message?.role !== "assistant") return undefined;
    // A complete message carries a non-null string stop_reason (e.g.
    // "end_turn"). Mid-stream entries carry null; some variants omit it
    // entirely — both read as incomplete.
    if (typeof entry.message?.stop_reason !== "string") return undefined;
    return extractText(entry.message?.content);
  });
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

// `wait`: blocks until there is something for the parent to do about the child
// — the turn ended (`done`, or `idle` once the tab has been seen), it stalled on
// a dialog (`blocked`), it resumed from one (`working`, only when the parent was
// last told `blocked`), or it is gone (`unknown`). Speaks the socket.
//
// The baseline is what the parent has already been told (`acked`), written by
// `prompt`, `collect` and `wait` itself. Anything at or below it is a state the
// parent has seen — herdr's `done` lingers until acknowledged, so without the
// baseline a stale `done` would resolve the wait instantly.
//
// Three things can hide a wake, and the loop below answers all three
// (ADR-0008):
//   - the state can land BEFORE the subscription opens (a turn that finishes
//     between `prompt` and the arming of `wait` stands in `done` and emits
//     nothing more), so each pass probes before it waits;
//   - a status event carries no sequence and can be missed entirely, so the
//     probe — not the event — decides what to report;
//   - a subscription can stop delivering without closing, so the wait never
//     blocks longer than one re-probe window on the event stream alone.
export interface WaitAck {
  seq?: number | undefined;
  status?: AgentStatus | undefined;
}

export interface WaitOutcome {
  snapshot: AgentSnapshot;
  // True when the budget ran out with nothing new: "still working, re-arm".
  // The wake channel always ends with a report, never a bare error.
  timed_out: boolean;
}

// Longest a single pass trusts the event stream before re-probing. Not a poll
// of the child's state — the floor under a subscription that goes quiet.
const REPROBE_WINDOW_MS = 60_000;
const DEFAULT_WAIT_MS = 3_600_000;

export async function waitChild(
  paneId: string,
  client: HerdrClient,
  timeoutMs = 0,
  acked: WaitAck = {},
): Promise<WaitOutcome> {
  const deadline = Date.now() + (timeoutMs || DEFAULT_WAIT_MS);
  const statuses = waitStatuses(acked.status);
  // With nothing acked there is no way to tell a state the parent has seen from
  // a new one, so the first probe becomes the baseline: the wait then reports
  // the next change rather than whatever the child happens to be doing now.
  let baseSeq = acked.seq;
  let last: AgentSnapshot = { ...GONE_SNAPSHOT, pane_id: paneId };

  for (;;) {
    const snap = await probe(client, paneId);
    if (snap === null) return { snapshot: last, timed_out: false };
    last = snap;
    if (baseSeq === undefined) baseSeq = snap.state_change_seq ?? 0;
    else if (isWake(snap, baseSeq, acked.status)) return { snapshot: snap, timed_out: false };

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { snapshot: last, timed_out: true };

    // Wait on the event stream, but never for longer than a re-probe window:
    // if the subscription goes quiet — or dies without closing — the next pass
    // reads the real state anyway. A socket error is not fatal for the same
    // reason.
    const event = await client
      .waitForStatus(paneId, statuses, {
        timeoutMs: Math.min(remaining, REPROBE_WINDOW_MS),
        fromSeq: baseSeq,
      })
      .catch(() => null);

    // An event is a state the child really entered, so report it rather than
    // re-reading and risking a state that has already moved on. herdr's status
    // events carry no sequence, so fill that in for the ack.
    if (event !== null) {
      const seq = event.state_change_seq ?? (await probe(client, paneId))?.state_change_seq;
      return {
        snapshot: seq === undefined ? event : { ...event, state_change_seq: seq },
        timed_out: false,
      };
    }
  }
}

// A pane with no detected agent is usually gone (closed, crashed), but
// detection also drops transiently — so confirm before calling it that.
async function probe(client: HerdrClient, paneId: string): Promise<AgentSnapshot | null> {
  const snap = await client.agentGet(paneId).catch(() => null);
  if (snap !== null) return snap;
  await sleep(NULL_PROBE_RETRY_MS);
  return client.agentGet(paneId).catch(() => null);
}

// How long to wait before confirming that a pane with no detected agent is
// really gone rather than momentarily undetected.
const NULL_PROBE_RETRY_MS = 750;

// The states the event stream is asked for. `working` joins them only as a
// resume signal: the parent was told the child is blocked and needs to know
// when it starts moving again.
function waitStatuses(ackedStatus: AgentStatus | undefined): AgentStatus[] {
  const statuses: AgentStatus[] = ["done", "idle", "blocked", "unknown"];
  if (ackedStatus === "blocked") statuses.push("working");
  return statuses;
}

// A snapshot for a pane that no longer resolves. `unknown` normalizes to `gone`
// downstream (collect, the pi parent role).
const GONE_SNAPSHOT: AgentSnapshot = {
  pane_id: "",
  tab_id: "",
  workspace_id: "",
  name: "",
  agent: "",
  agent_status: "unknown",
};

// Is this state something the parent has not been told and should act on? Any
// state the child stops working in qualifies; `working` qualifies only as the
// resume from a block the parent already knows about.
function isWake(snap: AgentSnapshot, baseSeq: number, ackedStatus?: AgentStatus): boolean {
  if ((snap.state_change_seq ?? 0) <= baseSeq) return false;
  if (snap.agent_status !== "working") return true;
  return ackedStatus === "blocked";
}

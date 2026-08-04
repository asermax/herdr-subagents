// The helper depends on these interfaces so tests can inject a fake that
// records the sequence of calls — the sequence is what the spec's acceptance
// criteria assert on.

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export type TerminalStatus = "done" | "gone";

export interface AgentSnapshot {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  name: string;
  agent: string;
  agent_status: AgentStatus;
  agent_session?: { kind: "path" | "id"; value: string; source?: string };
  state_change_seq?: number;
  cwd?: string;
  interactive_ready?: boolean;
}

export interface TabCreateResult {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
}

export interface TabCreateParams {
  workspaceId: string;
  cwd: string;
  label: string;
  env: Record<string, string>;
  focus: boolean;
}

export interface AgentStartParams {
  name: string;
  kind: "pi" | "claude";
  paneId: string;
  timeoutMs: number;
  args: string[];
}

// Operations the helper drives against herdr. The CLI surface (tab create,
// agent start, agent prompt, tab close, agent get) plus the socket-only event
// surface (events.wait). The real implementation shells out to `herdr` and
// opens the socket; the test fake records calls and answers from a script.
export interface HerdrClient {
  tabCreate(params: TabCreateParams): Promise<TabCreateResult>;
  tabClose(tabId: string): Promise<void>;
  agentStart(params: AgentStartParams): Promise<AgentSnapshot>;
  agentGet(target: string): Promise<AgentSnapshot | null>;
  agentRename(target: string, name: string): Promise<void>;
  agentPrompt(target: string, body: string): Promise<void>;
  // One-shot socket wait: resolves when the pane reaches one of the statuses,
  // or rejects on timeout. `fromSeq` lets the caller wait for a change after a
  // known sequence value rather than any matching status.
  waitForStatus(
    paneId: string,
    statuses: AgentStatus[],
    opts: { timeoutMs: number; fromSeq?: number },
  ): Promise<AgentSnapshot>;
}

export class HerdrError extends Error {
  readonly code: string;
  override readonly cause: unknown;
  constructor(
    code: string,
    message: string,
    cause?: unknown,
  ) {
    super(`${code}: ${message}`);
    this.code = code;
    this.cause = cause;
    this.name = "HerdrError";
  }
}

// Readiness outcomes distinguished by the spawn sequence.
export type ReadinessResult =
  | { ok: true; agent: AgentSnapshot }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "fast-fail"; message: string };

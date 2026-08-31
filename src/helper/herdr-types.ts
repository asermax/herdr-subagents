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

// A git worktree as herdr reports it. `open_workspace_id` is set when the
// worktree already has a workspace open on it — that is the join target.
export interface WorktreeInfo {
  path: string;
  branch?: string;
  label: string;
  is_linked_worktree: boolean;
  open_workspace_id?: string;
}

// What `worktree create` / `worktree open` hand back. herdr opens a workspace
// with its own first tab; `root_tab_id` is that tab, which the caller closes
// once it has created the child's own tab. Absent when the workspace was
// already open, where the tab belongs to whoever opened it.
export interface WorktreeOpened {
  workspace_id: string;
  path: string;
  root_tab_id?: string;
}

export interface WorktreeCreateParams {
  // The source checkout the worktree forks from, as a workspace or a path.
  workspaceId?: string;
  cwd?: string;
  branch?: string;
  base?: string;
  label?: string;
}

// The slice of a workspace `close` reads: `tab_count` decides whether the child
// being closed is the last one in its worktree.
export interface WorkspaceInfo {
  workspace_id: string;
  tab_count: number;
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
  // Terminal snapshot of the pane, as text. The only screen read in the
  // system: what a blocked child is waiting on lives on its screen and nowhere
  // else (the session log does not carry an unanswered dialog).
  agentRead(target: string, opts: { lines: number }): Promise<string>;
  // Key presses, not text. Answering a dialog is picking an option; sending a
  // prompt body is `agentPrompt`.
  agentSendKeys(target: string, keys: readonly string[]): Promise<void>;
  // One-shot socket wait: resolves when the pane reaches one of the statuses,
  // or rejects on timeout. `fromSeq` lets the caller wait for a change after a
  // known sequence value rather than any matching status.
  waitForStatus(
    paneId: string,
    statuses: AgentStatus[],
    opts: { timeoutMs: number; fromSeq?: number },
  ): Promise<AgentSnapshot>;
  // Git worktrees. herdr models a worktree as a workspace, so creating one
  // yields a workspace to put the child's tab in and removing one disposes the
  // workspace, its tabs, and the checkout together.
  worktreeList(opts: { workspaceId?: string; cwd?: string }): Promise<WorktreeInfo[]>;
  worktreeCreate(params: WorktreeCreateParams): Promise<WorktreeOpened>;
  worktreeOpen(params: { path: string; label?: string }): Promise<WorktreeOpened>;
  // Removes the checkout AND everything in its workspace. Never forced: a
  // checkout with uncommitted changes refuses, which is the caller's signal.
  worktreeRemove(workspaceId: string): Promise<void>;
  workspaceGet(workspaceId: string): Promise<WorkspaceInfo | null>;
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
  // herdr's `agent_not_ready`: the harness IS running and detected, sitting on
  // a startup dialog (a trust prompt, an approval). Distinct from fast-fail —
  // the child is alive, named, and one keypress from ready.
  | { ok: false; reason: "blocked"; message: string }
  | { ok: false; reason: "fast-fail"; message: string };

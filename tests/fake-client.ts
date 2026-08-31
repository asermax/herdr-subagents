// A fake HerdrClient for black-box tests. It records the sequence of CLI
// operations (tab create, agent start, prompt, close) — that sequence is what
// the spec's acceptance criteria assert on — and routes `waitForStatus` to the
// real socket client pointed at the stub server, so the `events.wait` framing
// is exercised end to end.

import { waitForStatusOverSocket } from "../src/helper/herdr-client";
import type {
  AgentSnapshot,
  AgentStatus,
  AgentStartParams,
  HerdrClient,
  TabCreateParams,
  TabCreateResult,
  WorkspaceInfo,
  WorktreeCreateParams,
  WorktreeInfo,
  WorktreeOpened,
} from "../src/helper/herdr-types";
import { HerdrError } from "../src/helper/herdr-types";

export interface Call {
  method: string;
  args: Record<string, unknown>;
}

export interface FakeOptions {
  socketPath: string;
  // Scripted agent snapshot returned by agentGet per pane.
  snapshots?: Record<string, AgentSnapshot>;
  // Scripted name returned for a pane after rename attempts (index by attempt).
  nameAfterRename?: Record<string, (attempt: number) => string>;
  // What agentStart returns, or throws. Index by agent name.
  startResult?: Record<
    string,
    | { ok: AgentSnapshot }
    | { error: { code: string; message: string } }
  >;
  // The state_change_seq to report on agentGet at each call index, to model
  // delivery advancing the sequence.
  seqByGetIndex?: (paneId: string, callIndex: number) => number | undefined;
  // Screen text returned by agentRead per pane. Absent panes read as empty.
  screens?: Record<string, string>;
  // Per-get snapshot overrides keyed by pane: return a partial merged over the
  // base, or undefined to use the base as-is. Models transient states (e.g. a
  // freshly-started agent briefly reporting `unknown`).
  snapshotByGetIndex?: Record<string, (callIndex: number) => Partial<AgentSnapshot> | undefined>;
  // Worktrees herdr already knows about, for the create-or-join decision.
  worktrees?: WorktreeInfo[];
  // Tab count per workspace, for close's last-one-out check. Absent workspaces
  // read as gone.
  tabCounts?: Record<string, number>;
  // Error thrown by worktreeRemove, keyed by workspace — models a dirty
  // checkout refusing removal.
  worktreeRemoveError?: Record<string, { code: string; message: string }>;
  // tab counter for ids.
}

export class FakeHerdrClient implements HerdrClient {
  calls: Call[] = [];
  private paneIdCounter = 1;
  private tabIdCounter = 1;
  private getCallCount: Record<string, number> = {};
  private renames: Record<string, number> = {};
  private worktreeCounter = 1;

  constructor(public opts: FakeOptions) {}

  private snapshotFor(paneId: string): AgentSnapshot | null {
    return this.opts.snapshots?.[paneId] ?? null;
  }

  async tabCreate(params: TabCreateParams): Promise<TabCreateResult> {
    this.calls.push({ method: "tab.create", args: { ...params } });
    const workspaceId = params.workspaceId;
    const paneId = `${workspaceId}:p${this.paneIdCounter++}`;
    const tabId = `${workspaceId}:t${this.tabIdCounter++}`;
    return { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId };
  }

  async tabClose(tabId: string): Promise<void> {
    this.calls.push({ method: "tab.close", args: { tabId } });
  }

  async agentStart(params: AgentStartParams): Promise<AgentSnapshot> {
    this.calls.push({ method: "agent.start", args: { ...params } });
    const res = this.opts.startResult?.[params.name];
    if (res && "error" in res) {
      throw new HerdrError(res.error.code, res.error.message);
    }
    if (res && "ok" in res) return res.ok;
    // Default: an idle agent.
    const ws = params.paneId.split(":")[0] ?? "w0";
    return {
      pane_id: params.paneId,
      tab_id: `${ws}:t0`,
      workspace_id: ws,
      name: params.name,
      agent: params.kind,
      agent_status: "idle",
      state_change_seq: 1,
    };
  }

  async agentGet(target: string): Promise<AgentSnapshot | null> {
    this.getCallCount[target] = (this.getCallCount[target] ?? 0) + 1;
    const idx = this.getCallCount[target];
    this.calls.push({ method: "agent.get", args: { target } });
    const base = this.snapshotFor(target);
    if (!base) return null;
    const seqOverride = this.opts.seqByGetIndex?.(target, idx);
    // Name after rename: a rename bumps the rename counter; the scripted
    // snapshot can override the reported name per rename attempt.
    const renameCount = this.renames[target] ?? 0;
    const nameFn = this.opts.nameAfterRename?.[target];
    const name = nameFn ? nameFn(renameCount) : base.name;
    const getOverride = this.opts.snapshotByGetIndex?.[target]?.(idx);
    const snap: AgentSnapshot = { ...base, name, ...(getOverride ?? {}) };
    if (seqOverride !== undefined) snap.state_change_seq = seqOverride;
    return snap;
  }

  async agentRename(target: string, name: string): Promise<void> {
    this.renames[target] = (this.renames[target] ?? 0) + 1;
    this.calls.push({ method: "agent.rename", args: { target, name } });
  }

  async agentPrompt(target: string, body: string): Promise<void> {
    this.calls.push({ method: "agent.prompt", args: { target, body } });
  }

  async agentRead(target: string, opts: { lines: number }): Promise<string> {
    this.calls.push({ method: "agent.read", args: { target, ...opts } });
    return this.opts.screens?.[target] ?? "";
  }

  async agentSendKeys(target: string, keys: readonly string[]): Promise<void> {
    this.calls.push({ method: "agent.send-keys", args: { target, keys: [...keys] } });
  }

  async waitForStatus(
    paneId: string,
    statuses: AgentStatus[],
    opts: { timeoutMs: number; fromSeq?: number },
  ): Promise<AgentSnapshot> {
    this.calls.push({
      method: "events.wait",
      args: { paneId, statuses, fromSeq: opts.fromSeq, timeoutMs: opts.timeoutMs },
    });
    return waitForStatusOverSocket(this.opts.socketPath, paneId, statuses, opts);
  }

  async worktreeList(opts: { workspaceId?: string; cwd?: string }): Promise<WorktreeInfo[]> {
    this.calls.push({ method: "worktree.list", args: { ...opts } });
    return this.opts.worktrees ?? [];
  }

  async worktreeCreate(params: WorktreeCreateParams): Promise<WorktreeOpened> {
    this.calls.push({ method: "worktree.create", args: { ...params } });
    const workspaceId = `wt${this.worktreeCounter++}`;
    return {
      workspace_id: workspaceId,
      path: `/worktrees/${params.branch ?? "unnamed"}`,
      root_tab_id: `${workspaceId}:t0`,
    };
  }

  async worktreeOpen(params: { path: string; label?: string }): Promise<WorktreeOpened> {
    this.calls.push({ method: "worktree.open", args: { ...params } });
    const workspaceId = `wt${this.worktreeCounter++}`;
    return { workspace_id: workspaceId, path: params.path, root_tab_id: `${workspaceId}:t0` };
  }

  async worktreeRemove(workspaceId: string): Promise<void> {
    this.calls.push({ method: "worktree.remove", args: { workspaceId } });
    const err = this.opts.worktreeRemoveError?.[workspaceId];
    if (err) throw new HerdrError(err.code, err.message);
  }

  async workspaceGet(workspaceId: string): Promise<WorkspaceInfo | null> {
    this.calls.push({ method: "workspace.get", args: { workspaceId } });
    const tabCount = this.opts.tabCounts?.[workspaceId];
    if (tabCount === undefined) return null;
    return { workspace_id: workspaceId, tab_count: tabCount };
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

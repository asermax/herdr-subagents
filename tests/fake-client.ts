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
  // tab counter for ids.
}

export class FakeHerdrClient implements HerdrClient {
  calls: Call[] = [];
  private paneIdCounter = 1;
  private tabIdCounter = 1;
  private getCallCount: Record<string, number> = {};
  private renames: Record<string, number> = {};

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
    const snap: AgentSnapshot = { ...base, name };
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

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

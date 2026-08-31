import type { AgentStatus, HerdrClient, ReadinessResult, WorktreeInfo } from "./herdr-types.js";
import { HerdrError } from "./herdr-types.js";
import type { RegistryEntry } from "./registry.js";
import { readScreen } from "./screen.js";

// spawn is a verify-and-repair sequence. Success from `agent start` is NOT
// evidence a child is spawned and addressable. One observed failure drives
// the repair step:
//   - agent name lost on 2 of 4 spawns -> verify-and-rename
// Prompt delivery verification lives in prompt.ts (the delegate skill's
// spawn/prompt split): spawn only creates + starts a child.

const GATE = "HERDR_SUBAGENT";

// herdr requires agent names matching [a-z][a-z0-9_-]{0,31}. When --agent is
// omitted, the label is the only descriptive input — slugify it into a valid
// name so a label like "delegation test" becomes "delegation-test".
export function slugifyAgentName(label: string): string {
  let slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 32) slug = slug.slice(0, 32).replace(/-+$/, "");
  return slug || "agent";
}

// The prefix for child-facing env the parent forwards down (dev loop).
// The gate itself is the bare HERDR_SUBAGENT; related signals use this prefix
// so they ride the same always-shared channel (ADR-0003 named the convention).
// herdr's own vars use the HERDR_* prefix; this one is ours.
const CHILD_ENV_PREFIX = "HERDR_SUBAGENT_";

/**
 * Collect the child-facing env to set on a spawned tab: the gate plus every
 * HERDR_SUBAGENT_* var the parent carries (always forwarded — no dev/prod
 * switch). Anything else in process.env is inherited by the pane naturally.
 */
export function childEnv(parentEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { [GATE]: "1" };
  for (const [key, value] of Object.entries(parentEnv)) {
    if (key.startsWith(CHILD_ENV_PREFIX) && value) {
      env[key] = value;
    }
  }
  return env;
}

// A child asked for a git worktree. The branch name is the identity: an
// unknown branch gets a fresh worktree, a branch already checked out is joined,
// which is how a second child lands in a sibling's checkout.
export interface WorktreeRequest {
  branch?: string;
  base?: string;
}

export interface SpawnInput {
  kind: "pi" | "claude";
  // Omitted for a generic spawn: the child runs the harness's default agent
  // (default system prompt) plus the herdr onboarding, with no role.
  agentName: string | undefined;
  label: string;
  // Parent's cwd — children live in the parent's workspace.
  cwd: string;
  workspaceId: string;
  // Extra argv forwarded to the child's harness (e.g. --extension, --skill on
  // pi; --plugin-directory on claude). Empty in production. Computed by the
  // caller from the parent's own launch argv (cli.ts).
  passThroughArgs?: readonly string[];
  // Extra env forwarded to the child's tab. Defaults to the gate plus
  // HERDR_SUBAGENT_* vars from process.env.
  passThroughEnv?: Record<string, string>;
  // When present, the child gets its own checkout in a worktree workspace
  // instead of a tab in the parent's. `cwd` stays the source checkout the
  // worktree forks from.
  worktree?: WorktreeRequest;
}

export interface SpawnResult {
  pane_id: string;
  tab_id: string;
  // Present for a worktree child. The branch is what the parent reports to the
  // human: it outlives the child and the checkout.
  worktree?: ChildWorktree;
}

export interface ChildWorktree {
  path: string;
  branch?: string;
}

// Tunable bounds. These are the helper's, not the model's. Exhausting one
// means a broken child: close the half-created tab and surface the pane. The
// startup-block bound is the exception — a child waiting on a dialog is not
// broken, so it keeps its tab (ADR-0007).
export interface SpawnBounds {
  // Bounds interactive readiness only. No harness takes longer than 10s to
  // come up; a timeout means not installed or failed to start.
  readinessTimeoutMs: number;
  // How long to give a child blocked during startup to clear on its own. A
  // transient boot screen clears in well under this; a real dialog never does
  // (it wants a keypress), so this is the cost of telling the two apart.
  startupBlockedMs: number;
  // verify-and-rename attempts (act on evidence; bounded).
  maxRenameAttempts: number;
  // prompt-delivery verification attempts (bounded resends).
  maxPromptAttempts: number;
  // How long to watch for an agent-status change or state-sequence advance
  // after sending the prompt. No transition in the window = dropped.
  deliveryStallMs: number;
}

export const DEFAULT_BOUNDS: SpawnBounds = {
  readinessTimeoutMs: 10_000,
  startupBlockedMs: 5_000,
  maxRenameAttempts: 3,
  maxPromptAttempts: 3,
  deliveryStallMs: 5_000,
};

export interface SpawnFailure {
  reason: "timeout" | "fast-fail" | "blocked" | "name" | "delivery" | "tab-create" | "worktree";
  message: string;
  // The half-created pane id, surfaced to the human if it cannot be cleaned up.
  pane_id?: string;
  tab_id?: string;
  // What the child is waiting on, on a `blocked` failure. The pane is still
  // open, so this is the parent's evidence for which keys answer the dialog.
  screen?: string;
}

export interface SpawnDeps {
  client: HerdrClient;
  bounds?: Partial<SpawnBounds>;
  // Optional registry tracking. When present, spawn records the child in the
  // registry right after tabCreate (so the event-driven watch discovers it via
  // pane.created without waiting for the full spawn sequence) and removes the
  // entry on failure. Absent in the spawn unit tests, which test mechanics.
  tracking?: SpawnTracking;
}

// The slice of Registry that spawn drives. The real Registry satisfies this;
// tests pass a plain object.
export interface SpawnTracking {
  add(entry: RegistryEntry): Promise<void>;
  remove(paneId: string): Promise<void>;
}

export async function spawnChild(
  input: SpawnInput,
  deps: SpawnDeps,
): Promise<SpawnResult> {
  const bounds = { ...DEFAULT_BOUNDS, ...deps.bounds };
  const { client } = deps;

  // 0. Resolve the worktree, when one was asked for. herdr models a worktree as
  //    a workspace, so this decides WHERE the child's tab is created, not how.
  //    Everything after is identical for both kinds of child.
  let resolved: ResolvedWorktree | undefined;
  if (input.worktree) {
    try {
      resolved = await resolveWorktree(client, input);
    } catch (e) {
      throw {
        reason: "worktree",
        message: `could not prepare the child's worktree: ${
          e instanceof Error ? e.message : String(e)
        }`,
      } satisfies SpawnFailure;
    }
  }

  const workspaceId = resolved?.workspaceId ?? input.workspaceId;

  // 1. Create the tab: the child's cwd is the worktree checkout when it has one
  //    and the parent's cwd otherwise; final label, no focus, the gate plus
  //    forwarded HERDR_SUBAGENT_* env in its environment.
  const env = input.passThroughEnv ?? childEnv();
  let tabId: string;
  let paneId: string;
  try {
    const tab = await client.tabCreate({
      workspaceId,
      cwd: resolved?.path ?? input.cwd,
      label: input.label,
      focus: false,
      env,
    });
    paneId = tab.pane_id;
    tabId = tab.tab_id;
  } catch (e) {
    // A worktree this spawn created has no children now and never will; take it
    // back out rather than leaving an empty checkout behind.
    if (resolved?.created) await removeQuietly(client, resolved.workspaceId);
    throw {
      reason: "tab-create",
      message: `could not create child tab: ${e instanceof Error ? e.message : String(e)}`,
    } satisfies SpawnFailure;
  }

  // The worktree workspace comes with a root tab of herdr's making. The child
  // has its own tab now, so drop it — closing it after ours means the workspace
  // is never empty, which would dispose it. Best-effort: a leftover shell in the
  // worktree is untidy, not broken.
  if (resolved?.rootTabId !== undefined) {
    try {
      await client.tabClose(resolved.rootTabId);
    } catch {
      // leave it; the human can close it.
    }
  }

  // Track the child in the registry NOW — right after tabCreate, before
  // agentStart. pane.created fires at tabCreate; spawn's registry write must
  // precede the (multi-second) agent-start/verify sequence so the event-driven
  // watch, on pane.created → reconcile, finds the child already tracked and
  // opens its status subscription. On any later failure the entry is removed.
  if (deps.tracking) {
    const effectiveAgent = input.agentName ?? slugifyAgentName(input.label);
    try {
      await deps.tracking.add({
        pane_id: paneId,
        tab_id: tabId,
        workspace_id: workspaceId,
        label: input.label,
        agent: effectiveAgent,
        kind: input.kind,
        agent_name: effectiveAgent,
        status: "idle",
        ...(resolved ? { worktree: toChildWorktree(resolved) } : {}),
      });
    } catch {
      // A registry write failure must not block the spawn; the watch's safety
      // reconcile + `helper list` keep the fleet honest.
    }
  }

  // Anything past here owns a half-created tab and must clean up on failure.
  const fail = (reason: SpawnFailure["reason"], message: string): SpawnFailure =>
    ({ reason, message, pane_id: paneId, tab_id: tabId });

  try {
    // 2. Start the harness with the chosen kind and agent name. A readiness
    //    timeout = not installed or failed to start; distinguish from a fast
    //    post-start failure (started + exited — unresolvable name on claude).
    const readiness = await startWithReadiness(client, paneId, input, bounds);
    if (!readiness.ok) {
      if (readiness.reason === "timeout") {
        throw fail(
          "timeout",
          `harness never became ready within ${bounds.readinessTimeoutMs}ms — not installed or failed to start`,
        );
      }
      // A child blocked during startup is running, detected, and named — it is
      // sitting on a dialog (a trust prompt, an approval). Give it the startup
      // window to clear on its own; if it does not, hand the live pane to the
      // parent with the dialog on it. This failure is the one that does NOT
      // close the tab: the child is not broken, it is waiting.
      if (readiness.reason === "blocked") {
        if (!(await clearsStartupBlock(client, paneId, bounds))) {
          const screen = await readScreen(client, paneId);
          const failure: SpawnFailure = {
            reason: "blocked",
            message: `child is blocked on a startup prompt and did not clear within ${
              bounds.startupBlockedMs
            }ms — the tab is kept: answer the prompt with unblock, or hand the pane to the human`,
            pane_id: paneId,
            tab_id: tabId,
          };
          if (screen !== undefined) failure.screen = screen;
          throw failure;
        }
      } else {
        throw fail(
          "fast-fail",
          `harness started and exited: ${readiness.message}`,
        );
      }
    }

    // 3. Verify the name landed; rename on evidence (bounded). This is the
    //    2-of-4 case. A generic spawn (no --agent) runs the harness default
    //    agent, whose reported name never matches — skip the verify entirely.
    if (input.agentName !== undefined) {
      await verifyAndRename(client, paneId, input.agentName, bounds);
    }

    return {
      pane_id: paneId,
      tab_id: tabId,
      ...(resolved ? { worktree: toChildWorktree(resolved) } : {}),
    };
  } catch (e) {
    // A blocked child owns its tab: it is alive and answerable, so it survives
    // the cleanup below and stays in the registry (the watch keeps streaming
    // it, `list` keeps showing it).
    if (isSpawnFailure(e) && e.reason === "blocked") throw e;

    // 4. On exhaustion of any bound, close the half-created tab and report.
    //    Never keep a broken child. Remove the registry entry BEFORE closing
    //    the tab: the event-driven watch reads the registry when the
    //    subscription connection dies (the tab close kills it) to tell a
    //    deliberate close (closed, no wake) from an unexpected loss (gone,
    //    wakes). Registry-first makes that signal race-free.
    if (deps.tracking) {
      try {
        await deps.tracking.remove(paneId);
      } catch {
        // best-effort
      }
    }
    // A worktree this spawn created has no other children — take the checkout
    // with the tab. A worktree it JOINED belongs to the siblings still in it, so
    // only the tab goes.
    if (resolved?.created) {
      await removeQuietly(client, resolved.workspaceId);
    } else {
      try {
        await client.tabClose(tabId);
      } catch {
        // Tab close failed — surface the pane id so the human can close it.
      }
    }
    if (isSpawnFailure(e)) throw { ...e, pane_id: paneId, tab_id: tabId };
    throw fail("name", e instanceof Error ? e.message : String(e));
  }
}

// Step 2: start the harness and classify the readiness outcome.
async function startWithReadiness(
  client: HerdrClient,
  paneId: string,
  input: SpawnInput,
  bounds: SpawnBounds,
): Promise<ReadinessResult> {
  try {
    // With --agent, name the child and pass --agent so it runs that role.
    // Without, omit --agent so the child runs the harness default agent; the
    // label is the tracking name herdr records (AgentStartParams.name is
    // required).
    const agentName = input.agentName;
    const args = agentName !== undefined
      ? ["--agent", agentName, ...(input.passThroughArgs ?? [])]
      : [...(input.passThroughArgs ?? [])];
    const agent = await client.agentStart({
      name: agentName ?? slugifyAgentName(input.label),
      kind: input.kind,
      paneId,
      timeoutMs: bounds.readinessTimeoutMs,
      args,
    });
    return { ok: true, agent };
  } catch (e) {
    if (e instanceof HerdrError) {
      if (e.code === "agent_start_timeout" || e.code === "timeout") {
        return { ok: false, reason: "timeout" };
      }
      // `agent_not_ready` is herdr reporting a detected agent that is blocked
      // during startup — it keeps the name and the pane. Treating it as a
      // fast-fail would report a live child as exited and then kill it.
      if (e.code === "agent_not_ready") {
        return { ok: false, reason: "blocked", message: e.message };
      }
      // Fast post-start failure: the harness started and exited, or the kind
      // is not installed. Anything else reads as fast-fail.
      return { ok: false, reason: "fast-fail", message: e.message };
    }
    return { ok: false, reason: "fast-fail", message: e instanceof Error ? e.message : String(e) };
  }
}

// Watch a startup-blocked pane for a move to any non-blocked state. Any wait
// failure counts as "did not clear": the outcome is the same either way (the
// tab is kept and the pane handed over), and a socket hiccup must never be the
// reason a live child gets closed.
async function clearsStartupBlock(
  client: HerdrClient,
  paneId: string,
  bounds: SpawnBounds,
): Promise<boolean> {
  const before = await client.agentGet(paneId).catch(() => null);
  if (before !== null && before.agent_status !== "blocked") return true;

  const statuses: AgentStatus[] = ["idle", "working", "done"];
  return client
    .waitForStatus(paneId, statuses, {
      timeoutMs: bounds.startupBlockedMs,
      fromSeq: before?.state_change_seq ?? 0,
    })
    .then(() => true)
    .catch(() => false);
}

// Step 3: verify the agent name landed; rename on evidence, bounded.
async function verifyAndRename(
  client: HerdrClient,
  paneId: string,
  expectedName: string,
  bounds: SpawnBounds,
): Promise<void> {
  for (let attempt = 0; attempt < bounds.maxRenameAttempts; attempt++) {
    const snap = await client.agentGet(paneId);
    // Detected and correctly named — done. `unknown` is not really detected
    // yet, so it does not count as success here.
    if (snap && snap.name === expectedName && snap.agent_status !== "unknown") return;
    // Not detected (no agent, or status `unknown`): a freshly-started harness
    // can briefly report this. Retry the read within the attempt budget — do
    // NOT rename a pane with no detected agent (rename fails and closes the
    // tab).
    if (snap === null || snap.agent_status === "unknown") continue;
    // Detected but the name is wrong — rename and re-verify (bounded).
    try {
      await client.agentRename(paneId, expectedName);
    } catch (e) {
      throw { reason: "name", message: `could not rename agent to ${expectedName}: ${
        e instanceof Error ? e.message : String(e)
      }` } satisfies SpawnFailure;
    }
  }
  throw { reason: "name", message: `agent name did not land after ${bounds.maxRenameAttempts} attempts` } satisfies SpawnFailure;
}

interface ResolvedWorktree {
  workspaceId: string;
  path: string;
  branch: string;
  // The tab herdr opened with the workspace, for the caller to close once the
  // child has its own. Absent when the workspace was already open — that tab
  // belongs to whoever opened it.
  rootTabId?: string;
  // This spawn brought the worktree into being, so this spawn owns undoing it.
  created: boolean;
}

function toChildWorktree(resolved: ResolvedWorktree): ChildWorktree {
  return { path: resolved.path, branch: resolved.branch };
}

/**
 * Create-or-join on branch name. A branch already checked out is joined, which
 * is what puts a reviewer in an implementer's checkout; an unknown branch gets
 * a fresh worktree. The branch defaults to the label, so a caller that just
 * wants isolation gets it without naming anything.
 */
async function resolveWorktree(
  client: HerdrClient,
  input: SpawnInput,
): Promise<ResolvedWorktree> {
  const branch = input.worktree?.branch ?? slugifyAgentName(input.label);

  // A list failure must not be read as "no such branch" — that would fork a
  // second worktree off a branch that already has one.
  const existing: WorktreeInfo | undefined = (
    await client.worktreeList({ workspaceId: input.workspaceId })
  ).find((w) => w.branch === branch);

  // Already open: the join case. No root tab of ours to close.
  if (existing?.open_workspace_id !== undefined) {
    return {
      workspaceId: existing.open_workspace_id,
      path: existing.path,
      branch,
      created: false,
    };
  }

  // Checked out but with no workspace on it — open one and adopt it.
  if (existing !== undefined) {
    const opened = await client.worktreeOpen({ path: existing.path, label: branch });
    return {
      workspaceId: opened.workspace_id,
      path: opened.path,
      branch,
      ...(opened.root_tab_id !== undefined ? { rootTabId: opened.root_tab_id } : {}),
      created: false,
    };
  }

  const created = await client.worktreeCreate({
    workspaceId: input.workspaceId,
    branch,
    label: branch,
    ...(input.worktree?.base !== undefined ? { base: input.worktree.base } : {}),
  });
  return {
    workspaceId: created.workspace_id,
    path: created.path,
    branch,
    ...(created.root_tab_id !== undefined ? { rootTabId: created.root_tab_id } : {}),
    created: true,
  };
}

// Cleanup-path removal. A failure here is reported by the caller's own failure,
// not this one: the spawn already went wrong and a stranded checkout is the
// lesser problem.
async function removeQuietly(client: HerdrClient, workspaceId: string): Promise<void> {
  try {
    await client.worktreeRemove(workspaceId);
  } catch {
    // leave it; `git worktree list` and the human can recover it.
  }
}

export function isSpawnFailure(value: unknown): value is SpawnFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SpawnFailure).reason === "string" &&
    typeof (value as SpawnFailure).message === "string"
  );
}

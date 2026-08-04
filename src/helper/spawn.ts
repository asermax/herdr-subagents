import type {
  AgentStatus,
  HerdrClient,
  ReadinessResult,
} from "./herdr-types.js";
import { HerdrError } from "./herdr-types.js";

// spawn is a verify-and-repair sequence. Success from `agent start` and
// `agent prompt` is NOT evidence a child is spawned and addressable. Two
// observed failures drive every step:
//   - agent name lost on 2 of 4 spawns        -> verify-and-rename
//   - first prompt dropped on 7 of 8 cold spins -> verify-delivery, resend
// Without this, spawn fails most of the time on pi.

const GATE = "HERDR_SUBAGENT";

// The prefix for child-facing env the parent forwards down (spec §9 dev loop).
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

export interface SpawnInput {
  kind: "pi" | "claude";
  agentName: string;
  label: string;
  // Parent's cwd — children live in the parent's workspace.
  cwd: string;
  workspaceId: string;
  body: string;
  // Extra argv forwarded to the child's harness (e.g. --extension, --skill on
  // pi; --plugin-directory on claude). Empty in production. Computed by the
  // caller from the parent's own launch argv (cli.ts).
  passThroughArgs?: readonly string[];
  // Extra env forwarded to the child's tab. Defaults to the gate plus
  // HERDR_SUBAGENT_* vars from process.env.
  passThroughEnv?: Record<string, string>;
}

export interface SpawnResult {
  pane_id: string;
  tab_id: string;
}

// Tunable bounds. These are the helper's, not the model's. Exhausting any of
// them means a broken child: close the half-created tab and surface the pane.
export interface SpawnBounds {
  // Bounds interactive readiness only. No harness takes longer than 10s to
  // come up; a timeout means not installed or failed to start.
  readinessTimeoutMs: number;
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
  maxRenameAttempts: 3,
  maxPromptAttempts: 3,
  deliveryStallMs: 5_000,
};

export interface SpawnFailure {
  reason: "timeout" | "fast-fail" | "name" | "delivery" | "tab-create";
  message: string;
  // The half-created pane id, surfaced to the human if it cannot be cleaned up.
  pane_id?: string;
  tab_id?: string;
}

export interface SpawnDeps {
  client: HerdrClient;
  bounds?: Partial<SpawnBounds>;
}

export async function spawnChild(
  input: SpawnInput,
  deps: SpawnDeps,
): Promise<SpawnResult> {
  const bounds = { ...DEFAULT_BOUNDS, ...deps.bounds };
  const { client } = deps;

  // 1. Create the tab in the parent's workspace: parent's cwd, final label,
  //    no focus, the gate plus forwarded HERDR_SUBAGENT_* env in its environment.
  const env = input.passThroughEnv ?? childEnv();
  let tabId: string;
  let paneId: string;
  try {
    const tab = await client.tabCreate({
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      label: input.label,
      focus: false,
      env,
    });
    paneId = tab.pane_id;
    tabId = tab.tab_id;
  } catch (e) {
    throw {
      reason: "tab-create",
      message: `could not create child tab: ${e instanceof Error ? e.message : String(e)}`,
    } satisfies SpawnFailure;
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
      throw fail(
        "fast-fail",
        `harness started and exited: ${readiness.message}`,
      );
    }

    // 3. Verify the name landed; rename on evidence (bounded). This is the
    //    2-of-4 case.
    await verifyAndRename(client, paneId, input.agentName, bounds);

    // 4. Send the task prompt and verify delivery by watching for a status
    //    change or state-sequence advance within the stall window. No
    //    transition = dropped, so resend (bounded). This is the 7-of-8 case.
    await sendPromptWithDelivery(client, paneId, input.body, bounds);

    return { pane_id: paneId, tab_id: tabId };
  } catch (e) {
    // 5. On exhaustion of any bound, close the half-created tab and report.
    //    Never keep a broken child.
    try {
      await client.tabClose(tabId);
    } catch {
      // Tab close failed — surface the pane id so the human can close it.
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
    const agent = await client.agentStart({
      name: input.agentName,
      kind: input.kind,
      paneId,
      timeoutMs: bounds.readinessTimeoutMs,
      args: ["--agent", input.agentName, ...(input.passThroughArgs ?? [])],
    });
    return { ok: true, agent };
  } catch (e) {
    if (e instanceof HerdrError) {
      if (e.code === "agent_start_timeout" || e.code === "timeout") {
        return { ok: false, reason: "timeout" };
      }
      // Fast post-start failure: the harness started and exited, or the kind
      // is not installed. Anything other than a timeout reads as fast-fail.
      return { ok: false, reason: "fast-fail", message: e.message };
    }
    return { ok: false, reason: "fast-fail", message: e instanceof Error ? e.message : String(e) };
  }
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

// Step 4: send the task prompt and verify delivery. We watch for an
// agent-status change OR a state-sequence advance within the stall window.
// We do NOT use a wait-until-working receipt — it false-negatives on fast
// turns (working->done can pass before we observe, making a delivered prompt
// look dropped). No transition in the window = dropped, so resend (bounded).
async function sendPromptWithDelivery(
  client: HerdrClient,
  paneId: string,
  body: string,
  bounds: SpawnBounds,
): Promise<void> {
  for (let attempt = 0; attempt < bounds.maxPromptAttempts; attempt++) {
    const before = await client.agentGet(paneId);
    const fromSeq = before?.state_change_seq ?? 0;
    await client.agentPrompt(paneId, body);

    // Any of: a status change away from idle/done, or a state-sequence
    // advance, counts as the prompt landing.
    const delivered = await waitForDelivery(client, paneId, fromSeq, bounds.deliveryStallMs);
    if (delivered) return;
    // No transition in the window -> dropped. Resend.
  }
  throw { reason: "delivery", message: `prompt not delivered after ${bounds.maxPromptAttempts} attempts` } satisfies SpawnFailure;
}

function waitForDelivery(
  client: HerdrClient,
  paneId: string,
  fromSeq: number,
  stallMs: number,
): Promise<boolean> {
  // Watch for working|blocked|done after the prompt. `fromSeq` skips a stale
  // replay of the pre-prompt state. A `done` here is fine: a fast turn passed
  // working->done and that is still evidence of delivery.
  const statuses: AgentStatus[] = ["working", "blocked", "done"];
  return client
    .waitForStatus(paneId, statuses, { timeoutMs: stallMs, fromSeq })
    .then(() => true)
    .catch((e: unknown) => {
      if (e instanceof HerdrError && (e.code === "wait_timeout" || e.code === "timeout")) {
        return false;
      }
      throw e;
    });
}

export function isSpawnFailure(value: unknown): value is SpawnFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SpawnFailure).reason === "string" &&
    typeof (value as SpawnFailure).message === "string"
  );
}

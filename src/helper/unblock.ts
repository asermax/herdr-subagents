import type { AgentStatus, HerdrClient } from "./herdr-types.js";
import { readScreen } from "./screen.js";

// `unblock` answers a dialog a child is stalled on — herdr's `blocked` state:
// a startup trust prompt, a tool approval. It sends key presses, watches for
// the pane to leave `blocked`, and reports what actually happened. Text goes
// through `prompt`; this surface is only for picking an option.

export interface UnblockBounds {
  // How long to watch for the pane to leave `blocked` after the keys land.
  clearStallMs: number;
  // Screen lines read back when the keys did not clear the block.
  screenLines: number;
}

export const DEFAULT_UNBLOCK_BOUNDS: UnblockBounds = {
  clearStallMs: 5_000,
  screenLines: 40,
};

export interface UnblockResult {
  pane_id: string;
  keys: readonly string[];
  // `gone` when the pane no longer resolves as an agent target.
  status: AgentStatus | "gone";
  cleared: boolean;
  // The pane as it stands, when the keys did not clear the block.
  screen?: string;
}

export interface UnblockRefusal {
  reason: "not-blocked" | "gone";
  message: string;
  pane_id: string;
  status: AgentStatus | "gone";
}

/**
 * Send `keys` to a blocked child and verify the block cleared.
 *
 * Refuses a pane that is not blocked: keys sent to an idle child are typed
 * into its prompt box, which silently corrupts the next prompt. The pane's
 * status is the gate, so the caller must observe `blocked` (from spawn, watch,
 * or `list`) before answering it.
 */
export async function unblockChild(
  client: HerdrClient,
  paneId: string,
  keys: readonly string[],
  bounds: UnblockBounds = DEFAULT_UNBLOCK_BOUNDS,
): Promise<UnblockResult> {
  const before = await client.agentGet(paneId);
  if (before === null) {
    throw {
      reason: "gone",
      message: `pane ${paneId} does not resolve as an agent — nothing to unblock`,
      pane_id: paneId,
      status: "gone",
    } satisfies UnblockRefusal;
  }
  if (before.agent_status !== "blocked") {
    throw {
      reason: "not-blocked",
      message: `pane ${paneId} is ${before.agent_status}, not blocked — keys would be typed into its prompt box; send text with prompt instead`,
      pane_id: paneId,
      status: before.agent_status,
    } satisfies UnblockRefusal;
  }

  await client.agentSendKeys(paneId, keys);

  const statuses: AgentStatus[] = ["idle", "working", "done"];
  // No transition in the window does not settle it: a status change can land
  // outside the subscription, so fall back to a direct read before calling the
  // block unanswered.
  const settled = await client
    .waitForStatus(paneId, statuses, {
      timeoutMs: bounds.clearStallMs,
      fromSeq: before.state_change_seq ?? 0,
    })
    .catch(() => null);
  const after = settled ?? (await client.agentGet(paneId).catch(() => null));

  const result: UnblockResult = {
    pane_id: paneId,
    keys,
    status: after?.agent_status ?? "gone",
    cleared: after !== null && after.agent_status !== "blocked",
  };

  if (!result.cleared) {
    const screen = await readScreen(client, paneId, bounds.screenLines);
    if (screen !== undefined) result.screen = screen;
  }

  return result;
}

export function isUnblockRefusal(value: unknown): value is UnblockRefusal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UnblockRefusal).reason === "string" &&
    typeof (value as UnblockRefusal).pane_id === "string"
  );
}

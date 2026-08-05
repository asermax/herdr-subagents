import type { AgentStatus, HerdrClient } from "./herdr-types.js";
import { HerdrError } from "./herdr-types.js";
import type { SpawnFailure } from "./spawn.js";

// `prompt` delivers a task and verifies delivery. A successful `agent.prompt`
// call is NOT evidence the child received it: on cold spins the first prompt
// is dropped on 7 of 8 attempts. So we send, watch for a status change or
// state-sequence advance within the stall window, and resend if nothing
// arrives (bounded). No transition in the window = dropped.

// Tunable bounds for delivery verification. Exhausting the attempts means the
// child never acted on the prompt.
export interface PromptBounds {
  // prompt-delivery verification attempts (bounded resends).
  maxPromptAttempts: number;
  // How long to watch for an agent-status change or state-sequence advance
  // after sending the prompt. No transition in the window = dropped.
  deliveryStallMs: number;
}

export const DEFAULT_PROMPT_BOUNDS: PromptBounds = {
  maxPromptAttempts: 3,
  deliveryStallMs: 5_000,
};

// Send the task prompt and verify delivery by watching for a status change
// away from idle/done OR a state-sequence advance within the stall window. No
// transition in the window = dropped, so resend (bounded). We do NOT use a
// wait-until-working receipt — it false-negatives on fast turns
// (working->done can pass before we observe, making a delivered prompt look
// dropped).
export async function deliverPrompt(
  client: HerdrClient,
  paneId: string,
  body: string,
  bounds: PromptBounds,
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

// Watch for working|blocked|done after the prompt. `fromSeq` skips a stale
// replay of the pre-prompt state. A `done` here is fine: a fast turn passed
// working->done and that is still evidence of delivery.
async function waitForDelivery(
  client: HerdrClient,
  paneId: string,
  fromSeq: number,
  stallMs: number,
): Promise<boolean> {
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

import type { AgentSnapshot, AgentStatus, HerdrClient } from "./herdr-types.js";
import { HerdrError } from "./herdr-types.js";
import { readScreen } from "./screen.js";
import type { SpawnFailure } from "./spawn.js";

// `prompt` delivers a task and verifies delivery. A successful `agent.prompt`
// call is NOT evidence the child received it: on cold spins the first prompt
// is dropped on 7 of 8 attempts. So we send, watch for a status change or
// state-sequence advance within the stall window, and resend if nothing
// arrives (bounded). No transition in the window = dropped. The exception is
// a child already `working` — a steer — handled inside the loop.

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

// Where the child stands once delivery is confirmed. The caller acks a sequence from this so a
// later `wait` knows which transitions are new (ADR-0008): the receipt's own
// seq when the child moved to `working`, and the pre-send seq when the child
// had already stopped working by the time we looked — that end-of-turn is a
// wake the parent has not had yet.
export interface PromptReceipt {
  // The pane's state sequence read just before the send that landed.
  before_seq: number;
  // Where the child stands right after delivery: working, or already blocked
  // or finished if the turn was short.
  status: AgentStatus;
  seq: number;
  // The sequence the caller should ack for this delivery.
  acked_seq: number;
}

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
): Promise<PromptReceipt> {
  let lastStatus: AgentStatus | undefined;
  for (let attempt = 0; attempt < bounds.maxPromptAttempts; attempt++) {
    const before = await client.agentGet(paneId);
    if (before !== null) lastStatus = before.agent_status;
    const fromSeq = before?.state_change_seq ?? 0;
    await client.agentPrompt(paneId, body);

    // A steer: the child was already working when we sent. A steer changes
    // nothing observable — herdr emits status events only on change, and a
    // turn that keeps running advances no sequence — so the wait below can
    // never confirm it and would resend a message the child is already acting
    // on (three identical steers, then a false failure). A working harness is
    // live and consuming input, so herdr's accepted submission is itself the
    // delivery evidence; herdr's own `agent prompt --wait` skips the
    // working-transition check for the same reason. The probe below still
    // catches the races: a turn that ended under the send reads as done with
    // a new seq, and `receipt` refuses to ack it so the parent still wakes.
    if (before?.agent_status === "working") {
      const now = await client.agentGet(paneId);
      return receipt(fromSeq, now ?? before);
    }

    // Any of: a status change away from idle/done, or a state-sequence
    // advance, counts as the prompt landing.
    const delivered = await waitForDelivery(client, paneId, fromSeq, bounds.deliveryStallMs);
    if (delivered !== null) {
      // herdr's status events carry no `state_change_seq` — only `agent.get`
      // does — so the receipt's sequence comes from a probe, not the event.
      // The probe also reports where the child stands NOW, which is what the
      // ack rule below needs (a fast turn can already be over).
      const now = await client.agentGet(paneId);
      return receipt(fromSeq, now ?? delivered);
    }
    // No transition in the window -> dropped. Resend.
  }
  // Why the child never acted — an error it threw, a dialog it sits on — lives
  // on its pane and nowhere else, so capture the screen as evidence before
  // failing.
  const screen = await readScreen(client, paneId);
  throw {
    reason: "delivery",
    message: `prompt sent ${bounds.maxPromptAttempts} times but the child never acted on it — last seen ${
      lastStatus ?? "undetected"
    }`,
    ...(screen !== undefined ? { screen } : {}),
  } satisfies SpawnFailure;
}

function receipt(beforeSeq: number, delivered: AgentSnapshot): PromptReceipt {
  const status = delivered.agent_status;
  const seq = delivered.state_change_seq ?? beforeSeq;
  return {
    before_seq: beforeSeq,
    status,
    seq,
    // A receipt that already shows the child stopped working (a turn that
    // finished inside the delivery window) must NOT be acked: acking it would
    // hide the very end-of-turn the parent is waiting for.
    acked_seq: status === "working" ? seq : beforeSeq,
  };
}

// Ack a delivery receipt on behalf of the caller. Only a `working` receipt is
// acked as itself; the other cases ack the pre-send state, which the parent
// has already acted on (ADR-0008). Shared by `prompt` and a `spawn --body`,
// which deliver through the same verify-and-resend path.
export async function ackDelivery(
  registry: { setAcked(paneId: string, seq: number, status?: AgentStatus): Promise<void> },
  paneId: string,
  receipt: PromptReceipt,
): Promise<void> {
  await registry.setAcked(
    paneId,
    receipt.acked_seq,
    receipt.status === "working" ? "working" : undefined,
  );
}

// Watch for working|blocked|done after the prompt. `fromSeq` skips a stale
// replay of the pre-prompt state. A `done` here is fine: a fast turn passed
// working->done and that is still evidence of delivery.
async function waitForDelivery(
  client: HerdrClient,
  paneId: string,
  fromSeq: number,
  stallMs: number,
): Promise<AgentSnapshot | null> {
  const statuses: AgentStatus[] = ["working", "blocked", "done"];
  return client
    .waitForStatus(paneId, statuses, { timeoutMs: stallMs, fromSeq })
    .catch((e: unknown) => {
      if (e instanceof HerdrError && (e.code === "wait_timeout" || e.code === "timeout")) {
        return null;
      }
      throw e;
    });
}

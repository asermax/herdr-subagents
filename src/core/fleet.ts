// The parent role's harness-agnostic core: one `helper watch` line in, the
// fleet status line and the wake (if any) out. Node-free and import-free —
// the pi extension imports it, and the Claude mod bundles it into a hooks
// module, whose environment has no Node.
//
// No coalescing here — each harness's delivery decides how a burst of wakes
// lands.

export const STATUS_KEY = "herdr-subagents";
export const WAKE_TYPE = "herdr-subagents:wake";

// `unknown` reads as `gone`: detection lost (CONTEXT.md / collect normalize).
// A finished turn and a lost child both wake. So does `blocked`: the child is
// stuck on a dialog and the parent is the only one watching that tab (ADR-0007).
const WAKES = new Set(["done", "gone", "blocked"]);

// Two wakes are defined by the transition rather than the status alone
// (ADR-0008), because `prev` is all this bridge has — the sequence lives in the
// helper:
//   - `idle` and `done` are herdr's SAME underlying state, `done` being the
//     unseen variant. A child whose tab has been seen finishes its turn as
//     `idle`, so an idle that FOLLOWS `working` is a finished turn; an idle that
//     follows anything else (a fresh child settling, an acknowledged `done`) is
//     not.
//   - `working` that FOLLOWS `blocked` is the child resuming — the parent asked
//     the human to answer a dialog and needs to know they did.
const TRANSITION_WAKES: Array<{ from: string; to: string }> = [
  { from: "working", to: "idle" },
  { from: "blocked", to: "working" },
];

// Statuses that drop a child from the live widget. `gone` (detection lost)
// and `closed` (the parent ran `helper close`) both shrink the summary; only
// `gone` wakes (it is terminal) — `closed` is deliberate and stays silent.
const REMOVED = new Set(["gone", "closed"]);

// The shape carried on every `helper watch` line: one per child status change.
export interface ChildStatus {
  pane_id: string;
  label: string;
  status: string;
}

// The status surface. `ctx.ui` (ExtensionUIContext) satisfies this; a
// test passes a plain spy. `setWidget(key, undefined)` clears the widget.
export interface StatusSink {
  setWidget(key: string, content: string[] | undefined): void;
}

// Sends the terminal-state wake. Mirrors the slice of ExtensionAPI.sendMessage
// the parent role uses, so the per-line logic is testable without a full pi.
export type WakeSender = (
  message: { customType: string; content: string; display: boolean },
  options: { triggerTurn: boolean },
) => void;

// Tracked-children state for one session. `processLine` mutates it; the widget
// is recomputed from it after every change.
export interface ParentRoleState {
  children: Map<string, ChildStatus>;
}

export function createParentRoleState(): ParentRoleState {
  return { children: new Map() };
}

// The status line summarizing every tracked child as `name: status`, ordered
// by pane id. Returns undefined when there are no children so the caller can
// clear the widget. Wrapped in a single-element array for setWidget. The name
// falls back to the pane id when a child has no label.
export function renderStatusLine(children: Map<string, ChildStatus>): string[] | undefined {
  if (children.size === 0) return undefined;
  const ordered = [...children.values()].sort((a, b) =>
    a.pane_id < b.pane_id ? -1 : a.pane_id > b.pane_id ? 1 : 0,
  );
  return [ordered.map((c) => `${c.label || c.pane_id}: ${c.status}`).join(" | ")];
}

// One watch line → one status-line refresh, plus a wake on terminal-only
// states. `gone` (detection lost) and `closed` (the parent ran `helper close`)
// drop the child from the tracked set so the summary shrinks; only `gone`
// wakes — `closed` is deliberate. Pipe-fitting: the spawn → line plumbing is
// exercised by the dev loop, but this core is unit-tested directly.
export function processLine(
  state: ParentRoleState,
  sink: StatusSink | undefined,
  sendWake: WakeSender,
  rawLine: string,
): void {
  let rec: ChildStatus;
  try {
    rec = JSON.parse(rawLine) as ChildStatus;
  } catch {
    return;
  }
  if (!rec.pane_id || !rec.status) return;

  // `unknown` reads as `gone`: detection lost (CONTEXT.md / collect normalize).
  // herdr never pushes `gone`; we derive it so a terminal wake still fires.
  const status = rec.status === "unknown" ? "gone" : rec.status;
  const prev = state.children.get(rec.pane_id);
  const child: ChildStatus = {
    pane_id: rec.pane_id,
    label: rec.label ?? prev?.label ?? "",
    status,
  };

  if (REMOVED.has(status)) {
    state.children.delete(rec.pane_id);
  } else {
    state.children.set(rec.pane_id, child);
  }

  sink?.setWidget(STATUS_KEY, renderStatusLine(state.children));

  const transitionWakes = TRANSITION_WAKES.some(
    (t) => t.to === status && prev?.status === t.from,
  );
  if (!WAKES.has(status) && !transitionWakes) return;

  // The wake — terminal state only, compact, no payload. triggerTurn wakes an
  // idle parent; mid-turn it queues and lands at the turn boundary.
  // Wake-then-collect: the parent collects deliberately.
  sendWake(
    { customType: WAKE_TYPE, content: wakeContent(child), display: true },
    { triggerTurn: true },
  );
}

// The wake carries no payload: a one-line nudge naming the child, its
// pane id, and the `subagent` tool command to run next, so the parent knows
// what to do without touching anything but the tool. The result is NOT here.
// The helper CLI is never named — on pi the tool is the model's only surface.
function wakeContent(rec: ChildStatus): string {
  const name = rec.label ? `"${rec.label}"` : rec.pane_id;
  if (rec.status === "blocked") {
    return `Child ${name} is blocked on a dialog. Use the subagent tool — read, pane_id ${rec.pane_id} — to see what it is asking, then tell the human to answer it in that tab.`;
  }
  if (rec.status === "working") {
    return `Child ${name} is no longer blocked and is working again.`;
  }
  return `Child ${name} reached ${rec.status}. Use the subagent tool — collect, pane_id ${rec.pane_id} — to read its result.`;
}

/**
 * Splits a stream's chunks into complete lines. A chunk may end mid-line or
 * hold several lines; the partial tail waits for the next chunk.
 */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";

  return (chunk) => {
    buffer += chunk;

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== "") onLine(line);
    }
  };
}

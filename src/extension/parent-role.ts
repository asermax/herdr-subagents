import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Parent-side role of the herdr-subagents pi extension. Owns ONLY the bridge
// between `helper watch` and the parent session:
//   - spawns `helper watch` once per session
//   - summarizes every tracked child as ONE footer status line
//     (ctx.ui.setStatus), recomputed on each change
//   - on a terminal state (done|gone) forwards a compact wake (pi.sendMessage
//     with triggerTurn); blocked NEVER wakes
//
// The extension holds NO herdr socket client and does NO extraction — it is a
// thin bridge, and all herdr knowledge stays single-sourced in the helper.
// The wake carries no payload: wake-then-collect.
// No coalescing — native delivery semantics already prevent a burst from
// derailing a turn.

export const STATUS_KEY = "herdr-subagents";
export const WAKE_TYPE = "herdr-subagents:wake";

// `unknown` reads as `gone`: detection lost (CONTEXT.md / collect normalize).
// Terminal states wake; blocked never does.
const TERMINAL = new Set(["done", "gone"]);

const moduleDir = dirname(fileURLToPath(import.meta.url));

// The helper binary ships at the package root (build/plan.ts emits
// `herdr-helper` there). The dev loop overrides with HERDR_SUBAGENT_HELPER
// (forwarded to children by spawn) so a session loading the extension from
// source can point at the built helper.
export function helperPath(): string {
  const override = process.env.HERDR_SUBAGENT_HELPER;
  if (override) return override;
  return join(packageRoot(moduleDir), "herdr-helper");
}

// Walk up from `start` to the nearest directory holding a package.json — the
// package root. Robust to compiled layouts (e.g. extension shipped under
// <pkg>/dist/extension/) where the extension file is not one level under the
// root. Falls back to `start` if no package.json is found.
export function packageRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

// The shape carried on every `helper watch` line: one per child status change.
export interface ChildStatus {
  pane_id: string;
  label: string;
  status: string;
}

// The footer status surface. `ctx.ui` (ExtensionUIContext) satisfies this; a
// test passes a plain spy. `setStatus(key, undefined)` clears the line.
export interface StatusSink {
  setStatus(key: string, text: string | undefined): void;
}

// Sends the terminal-state wake. Mirrors the slice of ExtensionAPI.sendMessage
// the parent role uses, so the per-line logic is testable without a full pi.
export type WakeSender = (
  message: { customType: string; content: string; display: boolean },
  options: { triggerTurn: boolean },
) => void;

// Tracked-children state for one session. `processLine` mutates it; the footer
// line is recomputed from it after every change.
export interface ParentRoleState {
  children: Map<string, ChildStatus>;
}

export function createParentRoleState(): ParentRoleState {
  return { children: new Map() };
}

// The footer line summarizing every tracked child as `name: status`, ordered
// by pane id. Returns undefined when there are no children so the caller can
// clear the line. The name falls back to the pane id when a child has no label.
export function renderStatusLine(children: Map<string, ChildStatus>): string | undefined {
  if (children.size === 0) return undefined;
  const ordered = [...children.values()].sort((a, b) =>
    a.pane_id < b.pane_id ? -1 : a.pane_id > b.pane_id ? 1 : 0,
  );
  return ordered.map((c) => `${c.label || c.pane_id}: ${c.status}`).join(" | ");
}

// One watch line → one status-line refresh, plus a wake on terminal-only
// states. `gone` (detection lost) drops the child from the tracked set so the
// summary shrinks; the wake still fires. Pipe-fitting: the spawn → line
// plumbing is exercised by the dev loop, but this core is unit-tested directly.
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

  if (status === "gone") {
    state.children.delete(rec.pane_id);
  } else {
    state.children.set(rec.pane_id, child);
  }

  sink?.setStatus(STATUS_KEY, renderStatusLine(state.children));

  if (!TERMINAL.has(status)) return;

  // The wake — terminal state only, compact, no payload. triggerTurn wakes an
  // idle parent; mid-turn it queues and lands at the turn boundary.
  // Wake-then-collect: the parent collects deliberately.
  sendWake(
    { customType: WAKE_TYPE, content: wakeContent(child), display: true },
    { triggerTurn: true },
  );
}

// The wake carries no payload: a one-line nudge naming the child and state, so
// the parent knows to collect. The result is NOT here.
function wakeContent(rec: ChildStatus): string {
  const name = rec.label ? `"${rec.label}"` : rec.pane_id;
  return `Child ${name} reached ${rec.status}. Run \`helper collect ${rec.pane_id}\` to read its result.`;
}

// The minimal surface the parent role reads from a spawned `helper watch`.
// `spawn` with stdin ignored + piped stdout yields this shape.
export interface WatchProcess {
  stdout: Readable & { setEncoding(encoding: string): void };
  on(event: "error" | "exit", listener: () => void): unknown;
  kill(): void;
}

export function registerParentRole(pi: ExtensionAPI): () => void {
  const unsubs: Array<() => void> = [];
  const state = createParentRoleState();
  const sendWake: WakeSender = (message, options) => {
    pi.sendMessage(message, options);
  };

  // The watch data callback runs outside any handler and so has no `ctx`. The
  // footer status sink lives on the handler context's `ctx.ui`, so capture it
  // once at session_start — stable for a single session.
  let ui: StatusSink | undefined;
  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
  });

  let child: WatchProcess | null = null;
  let buffer = "";
  let stopped = false;

  const start = () => {
    if (stopped || child) return;
    try {
      child = spawnWatch();
    } catch {
      // A spawn failure must not crash the session. The wake's durable
      // backstop is `helper list` — the parent never loses a child.
      child = null;
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === "") continue;
        processLine(state, ui, sendWake, line);
      }
    });
    // Errors/exit are swallowed: watch is best-effort telemetry. The registry
    // and `helper list` are the durable record; a dead watcher loses the live
    // status line but never loses a child.
    child.on("error", () => {
      child = null;
    });
    child.on("exit", () => {
      child = null;
    });
  };

  // Spawn once per session. A bare no-children registry is fine: watch stays
  // alive and quiet, the status line stays clear, and there is nothing to do
  // until a child is spawned. (New children appear on the next watch
  // resubscribe — the extension does not manage the subscription lifecycle;
  // the helper owns the registry.)
  start();

  const stop = () => {
    stopped = true;
    const c = child;
    child = null;
    if (c) {
      try {
        c.kill();
      } catch {
        // already gone
      }
    }
  };
  unsubs.push(stop);

  return () => {
    for (const fn of unsubs) {
      try {
        fn();
      } catch {
        // a failing unsub must not abort the rest
      }
    }
  };
}

function spawnWatch(): WatchProcess {
  return spawn(helperPath(), ["watch"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  }) as unknown as WatchProcess;
}

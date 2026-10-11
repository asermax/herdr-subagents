import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  STATUS_KEY,
  createLineSplitter,
  createParentRoleState,
  processLine,
  type StatusSink,
  type WakeSender,
} from "../core/fleet.js";

export {
  STATUS_KEY,
  WAKE_TYPE,
  createParentRoleState,
  processLine,
  renderStatusLine,
  type ChildStatus,
  type ParentRoleState,
  type StatusSink,
  type WakeSender,
} from "../core/fleet.js";

// Parent-side role of the herdr-subagents pi extension. Owns ONLY the bridge
// between `helper watch` and the parent session:
//   - spawns `helper watch` once per session
//   - summarizes every tracked child as ONE status line rendered as a widget
//     above the input (ctx.ui.setWidget), recomputed on each change
//   - on a state the parent must act on — a finished turn (done, or idle right
//     after working), a dialog the child is stuck on (blocked), the resume from
//     one (working right after blocked), or a lost child (gone) — forwards a
//     compact wake (pi.sendMessage with triggerTurn)
//
// The extension holds NO herdr socket client and does NO extraction — it is a
// thin bridge, and all herdr knowledge stays single-sourced in the helper.
// The wake carries no payload: wake-then-collect.
// No coalescing — native delivery semantics already prevent a burst from
// derailing a turn.

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
  // status-widget sink lives on the handler context's `ctx.ui`, so capture it
  // once at session_start — stable for a single session.
  let ui: StatusSink | undefined;
  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
  });

  let child: WatchProcess | null = null;
  let stopped = false;
  let restartTimer: NodeJS.Timeout | null = null;

  // A dead watcher clears the tracked set: the restarted watch re-seeds the
  // live children from the registry, and anything that closed while the
  // watcher was down must not linger on the widget.
  const resetState = () => {
    state.children.clear();
    ui?.setWidget(STATUS_KEY, undefined);
  };

  const scheduleRestart = () => {
    if (stopped || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      start();
    }, 2000);
  };

  const start = () => {
    if (stopped || child) return;
    try {
      child = spawnWatch();
    } catch {
      // A spawn failure must not crash the session — retry shortly. The wake's
      // durable backstop is `helper list` — the parent never loses a child.
      child = null;
      scheduleRestart();
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on(
      "data",
      createLineSplitter((line) => processLine(state, ui, sendWake, line)),
    );
    // Errors/exit are swallowed: watch is best-effort telemetry. The registry
    // and `helper list` are the durable record; a dead watcher loses the live
    // status line but never loses a child. It IS restarted, though — a single
    // transient failure must not silence the widget for the whole session.
    child.on("error", () => {
      child = null;
      resetState();
      scheduleRestart();
    });
    child.on("exit", () => {
      child = null;
      resetState();
      scheduleRestart();
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
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
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

import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Box, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

// Parent-side role of the herdr-subagents pi extension. Owns ONLY the bridge
// between `helper watch` and the parent session (spec §5, §9):
//   - spawns `helper watch` once per session
//   - forwards each change as a TUI-only status card (pi.appendEntry)
//   - on a terminal state (done|gone) forwards a compact wake (pi.sendMessage
//     with triggerTurn); blocked NEVER wakes
//
// The extension holds NO herdr socket client and does NO extraction — it is a
// thin bridge, and all herdr knowledge stays single-sourced in the helper
// (spec §3). The wake carries no payload: wake-then-collect (spec §5, §11).
// No coalescing — native delivery semantics already prevent a burst from
// derailing a turn.

const STATUS_CARD_TYPE = "herdr-subagents:status";
const WAKE_TYPE = "herdr-subagents:wake";

// `unknown` reads as `gone`: detection lost (CONTEXT.md / collect normalize).
// Terminal states wake; blocked never does.
const TERMINAL = new Set(["done", "gone"]);

const here = dirname(fileURLToPath(import.meta.url));

// The helper binary ships at the package root (build/harness.ts HELPER_BIN),
// alongside the extension. The dev loop overrides with HERDR_HELPER so a
// session loading the extension from source can point at the built helper.
export function helperPath(): string {
  const override = process.env.HERDR_HELPER;
  if (override) return override;
  // extension/<file> → package root → herdr-helper. The dev loop overrides
  // with HERDR_HELPER (the helper is not at src/herdr-helper in source).
  return join(dirname(here), "herdr-helper");
}

export interface StatusCard {
  pane_id: string;
  label: string;
  status: string;
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

  // One status-card renderer per child, TUI-only. Custom entries do not
  // participate in LLM context (research §1.6). The renderer updates in place
  // as appendEntry is called with new data.
  pi.registerEntryRenderer<StatusCard>(STATUS_CARD_TYPE, (entry, _opts, theme) => {
    const d = entry.data;
    if (!d) return undefined;
    return renderStatusCard(d, theme);
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
      // backstop is `helper list` (spec §5) — the parent never loses a child.
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
        forward(pi, line);
      }
    });
    // Errors/exit are swallowed: watch is best-effort telemetry. The registry
    // and `helper list` are the durable record; a dead watcher loses live
    // status cards but never loses a child.
    child.on("error", () => {
      child = null;
    });
    child.on("exit", () => {
      child = null;
    });
  };

  // Spawn once per session. A bare no-children registry is fine: watch stays
  // alive and quiet, and there is nothing to do until a child is spawned.
  // (New children appear on the next watch resubscribe — the extension does
  // not manage the subscription lifecycle; the helper owns the registry.)
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

// One forwarded line → one status card, plus a wake on terminal-only states.
// Pipe-fitting (spec Testing §"Not covered"): exercised by the dev loop, not
// unit-tested.
function forward(pi: ExtensionAPI, rawLine: string): void {
  let rec: StatusCard;
  try {
    rec = JSON.parse(rawLine) as StatusCard;
  } catch {
    return;
  }
  if (!rec.pane_id || !rec.status) return;

  // `unknown` reads as `gone`: detection lost (CONTEXT.md / collect normalize).
  // herdr never pushes `gone`; we derive it so a terminal wake still fires.
  const status = rec.status === "unknown" ? "gone" : rec.status;
  const card: StatusCard = {
    pane_id: rec.pane_id,
    label: rec.label ?? "",
    status,
  };

  // TUI-only status card per child — display, never sent to the LLM.
  pi.appendEntry<StatusCard>(STATUS_CARD_TYPE, card);

  if (!TERMINAL.has(status)) return;

  // The wake — terminal state only, compact, no payload. triggerTurn wakes an
  // idle parent; mid-turn it queues and lands at the turn boundary (research
  // §1.6). Wake-then-collect: the parent collects deliberately.
  pi.sendMessage(
    { customType: WAKE_TYPE, content: wakeContent(card), display: true },
    { triggerTurn: true },
  );
}

// The wake carries no payload: a one-line nudge naming the child and state, so
// the parent knows to collect. The result is NOT here.
function wakeContent(rec: StatusCard): string {
  const name = rec.label ? `"${rec.label}"` : rec.pane_id;
  return `Child ${name} reached ${rec.status}. Run \`helper collect ${rec.pane_id}\` to read its result.`;
}

function renderStatusCard(d: StatusCard, theme: Theme): Component {
  const color = statusThemeColor(d.status);
  const line = `${theme.bold(d.label || d.pane_id)} — ${theme.fg(color, d.status)}`;
  const box = new Box(1, 0);
  box.addChild(new Text(line));
  return box;
}

function statusThemeColor(status: string): ThemeColor {
  switch (status) {
    case "done":
    case "gone":
      return "success";
    case "blocked":
      return "warning";
    case "working":
      return "accent";
    default:
      return "muted";
  }
}

// `helper watch` streams one JSON line per child-status change. It is
// event-driven: each tracked child gets its own socket subscribed to
// `pane.agent_status_changed`, plus a one-shot `agent.get` baseline on a
// separate connection; a `pane.created` subscription discovers new children.
// These tests drive that model against the stub. The parent-role consumer side
// (processLine → footer line + wake) is covered at the bottom.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buildSync } from "esbuild";
import { StubHerdrServer } from "./stub-server.js";
import { fileRegistryStore } from "../src/helper/registry.js";
import { watchChildren, type WatchDeps, type WatchLine } from "../src/helper/watch.js";
import {
  processLine,
  createParentRoleState,
  STATUS_KEY,
  WAKE_TYPE,
} from "../src/extension/parent-role.js";

const BUILT = buildCliOnce();

function buildCliOnce(): string {
  const outDir = mkdtempSync(join(tmpdir(), "herdr-watch-build-"));
  try {
    buildSync({
      entryPoints: [join(process.cwd(), "src/helper/cli.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: join(outDir, "cli.mjs"),
    });
  } catch (e) {
    rmSync(outDir, { recursive: true, force: true });
    throw e;
  }
  return join(outDir, "cli.mjs");
}

let server: StubHerdrServer;
let tmpDir: string;
let registryPath: string;

beforeEach(async () => {
  server = new StubHerdrServer();
  await server.start();
  tmpDir = mkdtempSync(join(tmpdir(), "herdr-watch-test-"));
  registryPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await stopWatch();
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface RegistryEntry {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  label: string;
  agent: string;
  kind: "pi" | "claude";
  agent_name: string;
  status: string;
}

function seedRegistry(entries: RegistryEntry[]): void {
  const obj: Record<string, RegistryEntry> = {};
  for (const e of entries) obj[e.pane_id] = e;
  writeFileSync(registryPath, JSON.stringify(obj, null, 2));
}

const entry = (pane_id: string, label: string): RegistryEntry => ({
  pane_id,
  tab_id: pane_id.replace("p", "t"),
  workspace_id: "w1Z",
  label,
  agent: "doer",
  kind: "pi",
  agent_name: "doer",
  status: "idle",
});

// --- watch harness ------------------------------------------------------

// watchChildren resolves only on abort, so each test drives it with an
// AbortController and collects the parsed lines. safety reconcile is disabled
// for determinism (discovery is exercised explicitly via pane.created).
let lines: WatchLine[];
let controller: AbortController;
let watchPromise: Promise<void> | null;

function startWatch(deps: Partial<WatchDeps> = {}): void {
  lines = [];
  controller = new AbortController();
  watchPromise = watchChildren(
    server.socketPath,
    {
      store: fileRegistryStore(registryPath),
      out: (l: string) => lines.push(JSON.parse(l) as WatchLine),
      createdDebounceMs: 15,
      safetyReconcileMs: -1,
      fleetReconnectMs: 40,
      ...deps,
    },
    controller.signal,
  );
}

async function stopWatch(): Promise<void> {
  if (!controller || !watchPromise) return;
  controller.abort();
  await watchPromise;
  controller = undefined as unknown as AbortController;
  watchPromise = null;
}

const flush = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

const statuses = (): string[] => lines.map((l) => l.status);
const panes = (): string[] => lines.map((l) => l.pane_id);

describe("helper watch (subscriptions)", () => {
  it("seeds a live child's current status on subscribe", async () => {
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");

    startWatch();
    await flush();

    expect(lines).toEqual([
      { pane_id: "w1Z:p1", label: "cleaner", status: "working" },
    ]);
  });

  it("pushes a status change as an event", async () => {
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");
    startWatch();
    await flush();

    server.stream([{ paneId: "w1Z:p1", status: "done" }]);
    await flush();

    expect(statuses()).toEqual(["working", "done"]);
  });

  it("does not re-emit an unchanged status", async () => {
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");
    startWatch();
    await flush();

    server.stream([{ paneId: "w1Z:p1", status: "working" }]);
    await flush();

    expect(statuses()).toEqual(["working"]);
  });

  it("emits each live child once", async () => {
    seedRegistry([entry("w1Z:p2", "reviewer"), entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");
    server.setCurrentStatus("w1Z:p2", "done");
    startWatch();
    await flush();

    expect(panes().sort()).toEqual(["w1Z:p1", "w1Z:p2"]);
  });

  it("a stale pane's failed subscribe does not kill another child's stream", async () => {
    // THE REGRESSION: the old multiplexed watch died entirely when one stale
    // pane was in the registry. Per-pane connections isolate the failure — the
    // stale pane's subscribe resets only its own (never-live) connection.
    seedRegistry([entry("w1Z:p1", "stale-one"), entry("w1Z:p2", "live-one")]);
    server.markStale("w1Z:p1"); // subscribe resets p1's connection
    server.setCurrentStatus("w1Z:p2", "working");
    startWatch();
    await flush();

    // p1 never emitted (subscribe reset before it went live); p2 seeded.
    expect(lines.filter((l) => l.pane_id === "w1Z:p1")).toEqual([]);
    expect(lines.filter((l) => l.pane_id === "w1Z:p2")).toEqual([
      { pane_id: "w1Z:p2", label: "live-one", status: "working" },
    ]);

    // p2's stream survives p1's failure and keeps pushing changes.
    server.stream([{ paneId: "w1Z:p2", status: "done" }]);
    await flush();
    expect(statuses().filter((s) => s === "done")).toEqual(["done"]);
  });

  it("skips a stale registry entry (no emit, no crash)", async () => {
    seedRegistry([entry("w1Z:p1", "closed-long-ago")]);
    server.markStale("w1Z:p1");
    startWatch();
    await flush();

    // agent.get answers agent_not_found; the child contributes nothing.
    expect(lines).toEqual([]);
  });

  it("emits gone when a tracked child's tab closes while still tracked", async () => {
    // Closing a tab emits `tab_closed`. The child is still in the registry
    // (closed outside `helper close`, or a crash that took the tab with it),
    // so the watch reads `gone`.
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");
    startWatch();
    await flush();

    server.pushTabClosed("w1Z:t1"); // registry still tracks the child
    await flush(80);

    expect(statuses()).toEqual(["working", "gone"]);
  });

  it("emits closed (not gone) when the parent removed the child from the registry", async () => {
    // helper close removes the child from the registry BEFORE closing the tab
    // (registry-first), so the `tab_closed` correlate reads the child already
    // gone → `closed` (no wake), not `gone`.
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");
    startWatch();
    await flush();

    seedRegistry([]); // helper close removed it (registry first)
    server.pushTabClosed("w1Z:t1"); // then the tab close fired tab_closed
    await flush(80);

    expect(statuses()).toEqual(["working", "closed"]);
  });

  it("emits unknown (dead-pane) via the status subscription", async () => {
    // A harness that dies with its tab still open surfaces as `unknown` on the
    // status subscription (no tab_closed). The parent-role consumer normalizes
    // unknown → gone; the watch just forwards the status it is pushed.
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");
    startWatch();
    await flush();

    server.stream([{ paneId: "w1Z:p1", status: "unknown" }]);
    await flush();

    expect(statuses()).toEqual(["working", "unknown"]);
  });

  it("suppresses `unknown` while a child is still booting; emits it once it was alive", async () => {
    // A freshly-started harness briefly reports `unknown` while booting —
    // spawn's own verify-and-rename treats it the same way. Forwarding it
    // would read as `gone` downstream (parent-role normalizes unknown → gone)
    // and wake the parent for a child that is fine. So it is suppressed until
    // a real status lands; only then is `unknown` a genuine loss.
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "unknown"); // baseline: still booting
    startWatch();
    await flush();

    expect(statuses()).toEqual([]); // booting `unknown` suppressed

    server.stream([{ paneId: "w1Z:p1", status: "working" }]); // booted
    await flush();
    expect(statuses()).toEqual(["working"]);

    server.stream([{ paneId: "w1Z:p1", status: "unknown" }]); // now a real loss
    await flush();
    expect(statuses()).toEqual(["working", "unknown"]);
  });

  it("picks up a child registered after watch starts via pane.created", async () => {
    seedRegistry([entry("w1Z:p1", "first")]);
    server.setCurrentStatus("w1Z:p1", "working");
    startWatch();
    await flush();

    // A second child is spawned mid-session: registry add + pane.created.
    seedRegistry([entry("w1Z:p1", "first"), entry("w1Z:p2", "second")]);
    server.setCurrentStatus("w1Z:p2", "idle");
    server.pushPaneCreated("w1Z:p2");
    await flush(60); // includes the created-debounce window

    expect(lines.find((l) => l.pane_id === "w1Z:p2")).toEqual({
      pane_id: "w1Z:p2",
      label: "second",
      status: "idle",
    });
  });

  it("emits nothing when no children are registered", async () => {
    seedRegistry([]);
    startWatch();
    await flush();
    expect(lines).toEqual([]);
  });
});

describe("runWatch CLI", () => {
  it("fails fast when HERDR_SOCKET_PATH is unset", async () => {
    seedRegistry([]);
    const child = spawn("node", [BUILT, "watch"], {
      env: { ...process.env, HERDR_SOCKET_PATH: "", HERDR_REGISTRY_PATH: registryPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise<number | null>((resolve) =>
      child.on("close", (c) => resolve(c)),
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/HERDR_SOCKET_PATH/);
  });
});

describe("parent-role status line", () => {
  // processLine is the bridge between watch output and the footer status line.
  // Driven directly with a fake sink (the captured ctx.ui) and a fake wake
  // sender.

  function setup() {
    const state = createParentRoleState();
    const setWidget = vi.fn();
    const sink = { setWidget };
    const sendWake = vi.fn();
    return { state, sink, sendWake, setWidget };
  }

  const line = (pane_id: string, status: string, label = ""): string =>
    JSON.stringify({ pane_id, label, status });

  it("a status change sets a status widget naming the child and its status", () => {
    const { state, sink, sendWake, setWidget } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "working", "cleaner"));

    expect(setWidget).toHaveBeenCalledTimes(1);
    expect(setWidget).toHaveBeenCalledWith(STATUS_KEY, ["cleaner: working"]);
  });

  it("falls back to the pane id when the child has no label", () => {
    const { state, sink, sendWake, setWidget } = setup();
    processLine(state, sink, sendWake, line("w1Z:p9", "idle"));
    expect(setWidget).toHaveBeenCalledWith(STATUS_KEY, ["w1Z:p9: idle"]);
  });

  it("summarizes every tracked child in one line, ordered by pane id", () => {
    const { state, sink, sendWake, setWidget } = setup();
    processLine(state, sink, sendWake, line("w1Z:p2", "done", "reviewer"));
    processLine(state, sink, sendWake, line("w1Z:p1", "working", "cleaner"));

    expect(setWidget).toHaveBeenLastCalledWith(
      STATUS_KEY,
      ["cleaner: working | reviewer: done"],
    );
  });

  it("clears the widget (setWidget undefined) when no children remain", () => {
    const { state, sink, sendWake, setWidget } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "working", "cleaner"));
    expect(setWidget).toHaveBeenLastCalledWith(STATUS_KEY, ["cleaner: working"]);

    // gone = detection lost: the child drops out of the live summary.
    processLine(state, sink, sendWake, line("w1Z:p1", "gone", "cleaner"));
    expect(setWidget).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
  });

  it("normalizes unknown to gone and clears when that empties the fleet", () => {
    const { state, sink, sendWake, setWidget } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "working", "cleaner"));
    processLine(state, sink, sendWake, line("w1Z:p1", "unknown", "cleaner"));
    expect(setWidget).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
  });

  it("wakes (triggerTurn) on terminal done, naming the child and state", () => {
    const { state, sink, sendWake } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "done", "reviewer"));

    expect(sendWake).toHaveBeenCalledTimes(1);
    expect(sendWake).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: WAKE_TYPE,
        content: expect.stringContaining("reviewer"),
        display: true,
      }),
      { triggerTurn: true },
    );
  });

  it("wakes on gone too (and drops the child from the line)", () => {
    const { state, sink, sendWake } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "gone", "cleaner"));
    expect(sendWake).toHaveBeenCalledWith(
      expect.objectContaining({ customType: WAKE_TYPE }),
      { triggerTurn: true },
    );
  });

  it("drops a closed child from the widget without waking", () => {
    const { state, sink, sendWake, setWidget } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "done", "reviewer"));
    processLine(state, sink, sendWake, line("w1Z:p1", "closed", "reviewer"));

    // The widget empties (the only child left), but no extra wake fires —
    // only the earlier done wake, never one for closed.
    expect(setWidget).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
    expect(sendWake).toHaveBeenCalledTimes(1);
  });

  it("does NOT wake on a non-terminal status (working/blocked/idle)", () => {
    const { state, sink, sendWake } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "working", "cleaner"));
    processLine(state, sink, sendWake, line("w1Z:p1", "blocked", "cleaner"));
    processLine(state, sink, sendWake, line("w1Z:p1", "idle", "cleaner"));
    expect(sendWake).not.toHaveBeenCalled();
  });

  it("ignores a malformed line and leaves the line untouched", () => {
    const { state, sink, sendWake, setWidget } = setup();
    processLine(state, sink, sendWake, "not json");
    expect(setWidget).not.toHaveBeenCalled();
    expect(sendWake).not.toHaveBeenCalled();
  });

  it("ignores a line missing pane_id or status", () => {
    const { state, sink, sendWake, setWidget } = setup();
    processLine(state, sink, sendWake, JSON.stringify({ pane_id: "w1Z:p1" }));
    processLine(state, sink, sendWake, JSON.stringify({ status: "working" }));
    expect(setWidget).not.toHaveBeenCalled();
  });
});

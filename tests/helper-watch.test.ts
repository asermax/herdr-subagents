// `helper watch` polls agent.get per child and emits one JSON line per status
// change. pollOnce is the unit: one probe cycle over the parent's registry
// (served here by the stub). The parent-role consumer side (processLine →
// footer line + wake) is covered at the bottom.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buildSync } from "esbuild";
import { StubHerdrServer } from "./stub-server.js";
import { fileRegistryStore } from "../src/helper/registry.js";
import { pollOnce } from "../src/helper/watch.js";
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

// Run one poll cycle against the stub + the temp registry, collecting emitted
// lines. `last` carries tracked state across cycles (emit-on-change).
async function poll(
  last: Map<string, { label: string; status: string }> = new Map(),
): Promise<{ lines: string[]; last: Map<string, { label: string; status: string }> }> {
  const lines: string[] = [];
  await pollOnce(
    server.socketPath,
    { store: fileRegistryStore(registryPath), out: (l) => lines.push(l) },
    last,
  );
  return { lines, last };
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

describe("helper watch (pollOnce)", () => {
  it("emits a live child's current status on the first poll", async () => {
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");

    const { lines } = await poll();

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      pane_id: "w1Z:p1",
      label: "cleaner",
      status: "working",
    });
  });

  it("does not re-emit an unchanged status on the next poll", async () => {
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");

    const { last } = await poll();
    const { lines } = await poll(last);

    expect(lines).toEqual([]);
  });

  it("emits on a status change", async () => {
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");
    const { last } = await poll();

    server.setCurrentStatus("w1Z:p1", "done");
    const { lines } = await poll(last);

    expect(lines.map((l) => JSON.parse(l).status)).toEqual(["done"]);
  });

  it("emits gone when a tracked child disappears", async () => {
    seedRegistry([entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");
    const { last } = await poll();

    server.markStale("w1Z:p1");
    const { lines } = await poll(last);

    expect(lines.map((l) => JSON.parse(l).status)).toEqual(["gone"]);
  });

  it("skips a stale registry entry (no emit, no crash)", async () => {
    seedRegistry([entry("w1Z:p1", "closed-long-ago")]);
    server.markStale("w1Z:p1");

    const { lines } = await poll();

    // agent.get answers agent_not_found; the child contributes nothing.
    expect(lines).toEqual([]);
  });

  it("emits each live child once", async () => {
    seedRegistry([entry("w1Z:p2", "reviewer"), entry("w1Z:p1", "cleaner")]);
    server.setCurrentStatus("w1Z:p1", "working");
    server.setCurrentStatus("w1Z:p2", "done");

    const { lines } = await poll();

    // Order is the parent-role's job (it sorts the footer); the watch just emits
    // one line per live child.
    const byPane = lines.map((l) => JSON.parse(l).pane_id).sort();
    expect(byPane).toEqual(["w1Z:p1", "w1Z:p2"]);
  });

  it("picks up a child registered after watch starts", async () => {
    seedRegistry([entry("w1Z:p1", "first")]);
    server.setCurrentStatus("w1Z:p1", "working");
    const { last } = await poll();

    // A second child appears in the registry (spawned mid-session).
    seedRegistry([entry("w1Z:p1", "first"), entry("w1Z:p2", "second")]);
    server.setCurrentStatus("w1Z:p2", "idle");
    const { lines } = await poll(last);

    // p1 unchanged (no emit); p2 is new.
    expect(lines.map((l) => JSON.parse(l).pane_id)).toEqual(["w1Z:p2"]);
  });

  it("emits nothing when no children are registered", async () => {
    seedRegistry([]);
    const { lines } = await poll();
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
    const setStatus = vi.fn();
    const sink = { setStatus };
    const sendWake = vi.fn();
    return { state, sink, sendWake, setStatus };
  }

  const line = (pane_id: string, status: string, label = ""): string =>
    JSON.stringify({ pane_id, label, status });

  it("a status change sets a footer line naming the child and its status", () => {
    const { state, sink, sendWake, setStatus } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "working", "cleaner"));

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, "cleaner: working");
  });

  it("falls back to the pane id when the child has no label", () => {
    const { state, sink, sendWake, setStatus } = setup();
    processLine(state, sink, sendWake, line("w1Z:p9", "idle"));
    expect(setStatus).toHaveBeenCalledWith(STATUS_KEY, "w1Z:p9: idle");
  });

  it("summarizes every tracked child in one line, ordered by pane id", () => {
    const { state, sink, sendWake, setStatus } = setup();
    processLine(state, sink, sendWake, line("w1Z:p2", "done", "reviewer"));
    processLine(state, sink, sendWake, line("w1Z:p1", "working", "cleaner"));

    expect(setStatus).toHaveBeenLastCalledWith(
      STATUS_KEY,
      "cleaner: working | reviewer: done",
    );
  });

  it("clears the line (setStatus undefined) when no children remain", () => {
    const { state, sink, sendWake, setStatus } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "working", "cleaner"));
    expect(setStatus).toHaveBeenLastCalledWith(STATUS_KEY, "cleaner: working");

    // gone = detection lost: the child drops out of the live summary.
    processLine(state, sink, sendWake, line("w1Z:p1", "gone", "cleaner"));
    expect(setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
  });

  it("normalizes unknown to gone and clears when that empties the fleet", () => {
    const { state, sink, sendWake, setStatus } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "working", "cleaner"));
    processLine(state, sink, sendWake, line("w1Z:p1", "unknown", "cleaner"));
    expect(setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
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

  it("does NOT wake on a non-terminal status (working/blocked/idle)", () => {
    const { state, sink, sendWake } = setup();
    processLine(state, sink, sendWake, line("w1Z:p1", "working", "cleaner"));
    processLine(state, sink, sendWake, line("w1Z:p1", "blocked", "cleaner"));
    processLine(state, sink, sendWake, line("w1Z:p1", "idle", "cleaner"));
    expect(sendWake).not.toHaveBeenCalled();
  });

  it("ignores a malformed line and leaves the line untouched", () => {
    const { state, sink, sendWake, setStatus } = setup();
    processLine(state, sink, sendWake, "not json");
    expect(setStatus).not.toHaveBeenCalled();
    expect(sendWake).not.toHaveBeenCalled();
  });

  it("ignores a line missing pane_id or status", () => {
    const { state, sink, sendWake, setStatus } = setup();
    processLine(state, sink, sendWake, JSON.stringify({ pane_id: "w1Z:p1" }));
    processLine(state, sink, sendWake, JSON.stringify({ status: "working" }));
    expect(setStatus).not.toHaveBeenCalled();
  });
});

// Seam 1 (spec Testing §Seam 1): the `helper watch` subcommand, black-box.
//
// `watch` is a long-lived stream: it subscribes to `pane.agent_status_changed`
// for every registered child over the newline-delimited JSON-RPC socket and
// emits one line of JSON per change. The stub server is extended to speak
// `events.subscribe` — it acks `subscription_started`, then streams the
// scripted changes. `watch` reads the registry to know which children to watch.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { buildSync } from "esbuild";
import { StubHerdrServer, type StreamedChange } from "./stub-server.js";

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

// Spawn `helper watch` against the stub, collect stdout lines until N arrive
// (or the timeout fires). watch stays alive by design — we drain a bounded
// number of lines and kill it.
function runWatch(opts: {
  timeoutMs?: number;
  collectLines: number;
}): Promise<{ lines: string[]; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("node", [BUILT, "watch"], {
      env: {
        ...process.env,
        HERDR_SOCKET_PATH: server.socketPath,
        HERDR_REGISTRY_PATH: registryPath,
        // A fast poll keeps the test snappy: the stub streams as fast as we
        // script it.
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const lines: string[] = [];
    let stderr = "";
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
      resolve({ lines, stderr, code });
    };

    child.stdout.on("data", (d) => {
      for (const raw of d.toString().split("\n")) {
        if (raw.trim() !== "") lines.push(raw);
      }
      if (lines.length >= opts.collectLines) finish(null);
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => finish(code));

    setTimeout(() => finish(null), opts.timeoutMs ?? 3000);
  });
}

describe("helper watch", () => {
  it("emits one JSON line per status change for registered children", async () => {
    seedRegistry([
      {
        pane_id: "w1Z:p1",
        tab_id: "w1Z:t1",
        workspace_id: "w1Z",
        label: "do the thing",
        agent: "doer",
        kind: "pi",
        agent_name: "doer",
        status: "idle",
      },
    ]);

    server.stream([
      { paneId: "w1Z:p1", status: "working" },
      { paneId: "w1Z:p1", status: "blocked" },
      { paneId: "w1Z:p1", status: "done" },
    ] as StreamedChange[]);

    const { lines } = await runWatch({ collectLines: 3 });

    expect(lines).toHaveLength(3);
    const statuses = lines.map((l) => JSON.parse(l).status);
    expect(statuses).toEqual(["working", "blocked", "done"]);
  });

  it("each line carries pane_id, status, and label", async () => {
    seedRegistry([
      {
        pane_id: "w1Z:p2",
        tab_id: "w1Z:t2",
        workspace_id: "w1Z",
        label: "fix the bug",
        agent: "fixer",
        kind: "claude",
        agent_name: "fixer",
        status: "idle",
      },
    ]);

    server.stream([{ paneId: "w1Z:p2", status: "done" }] as StreamedChange[]);

    const { lines } = await runWatch({ collectLines: 1 });
    const rec = JSON.parse(lines[0]!);

    // label travels in the line so the parent can name children in a fleet.
    expect(rec.pane_id).toBe("w1Z:p2");
    expect(rec.status).toBe("done");
    expect(rec.label).toBe("fix the bug");
  });

  it("subscribes to every registered child and not to unregistered panes", async () => {
    seedRegistry([
      {
        pane_id: "w1Z:p1",
        tab_id: "w1Z:t1",
        workspace_id: "w1Z",
        label: "tracked",
        agent: "doer",
        kind: "pi",
        agent_name: "doer",
        status: "idle",
      },
    ]);

    // The stub streams a change for an unregistered pane too. The watcher must
    // not emit it — it only ever subscribed to registered children.
    server.stream([
      { paneId: "w1Z:p1", status: "done" },
      { paneId: "w1Z:pX", status: "done" },
    ] as StreamedChange[]);

    const { lines } = await runWatch({ collectLines: 1, timeoutMs: 1500 });

    const emitted = lines.map((l) => JSON.parse(l).pane_id);
    expect(emitted).toEqual(["w1Z:p1"]);
  });

  it("stops forwarding a child after a pane.closed event", async () => {
    seedRegistry([
      {
        pane_id: "w1Z:p1",
        tab_id: "w1Z:t1",
        workspace_id: "w1Z",
        label: "tracked",
        agent: "doer",
        kind: "pi",
        agent_name: "doer",
        status: "idle",
      },
    ]);

    // p1 streams working first; then pane.closed drops it; then a `done` for
    // p1 must NOT be forwarded.
    server.stream([{ paneId: "w1Z:p1", status: "working" }] as StreamedChange[]);
    setTimeout(() => {
      server.pushPaneClosed("w1Z:p1");
      server.stream([{ paneId: "w1Z:p1", status: "done" }] as StreamedChange[]);
    }, 200);

    // collectLines: 2 so it waits for a second line that must never arrive;
    // the timeout bounds the wait. Only `working` should be emitted.
    const { lines } = await runWatch({ collectLines: 2, timeoutMs: 1000 });

    const statuses = lines.map((l) => JSON.parse(l).status);
    expect(statuses).toEqual(["working"]);
  });

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

  it("emits nothing when no children are registered", async () => {
    seedRegistry([]);
    // Nothing to subscribe to; watch stays alive and quiet.
    const { lines } = await runWatch({ collectLines: 1, timeoutMs: 800 });
    expect(lines).toEqual([]);
  });
});

describe("helper watch mid-session children", () => {
  it("re-subscribes to children registered after watch starts on pane.created", async () => {
    // Start with one child tracked.
    seedRegistry([
      {
        pane_id: "w1Z:p1",
        tab_id: "w1Z:t1",
        workspace_id: "w1Z",
        label: "first",
        agent: "doer",
        kind: "pi",
        agent_name: "doer",
        status: "idle",
      },
    ]);

    // p1 streams immediately; p2 is NOT subscribed at startup. After a
    // pane.created event, watch re-reads the registry, finds p2 now tracked,
    // and subscribes to it — then p2's change streams.
    server.stream([{ paneId: "w1Z:p1", status: "done" }] as StreamedChange[]);
    // Add p2 to the registry, then push a pane.created event so watch re-reads.
    setTimeout(() => {
      seedRegistry([
        {
          pane_id: "w1Z:p1",
          tab_id: "w1Z:t1",
          workspace_id: "w1Z",
          label: "first",
          agent: "doer",
          kind: "pi",
          agent_name: "doer",
          status: "idle",
        },
        {
          pane_id: "w1Z:p2",
          tab_id: "w1Z:t2",
          workspace_id: "w1Z",
          label: "second",
          agent: "doer",
          kind: "pi",
          agent_name: "doer",
          status: "idle",
        },
      ]);
      server.pushPaneCreated("w1Z:p2");
      // Now a status change for the newly-subscribed p2 must stream.
      server.stream([{ paneId: "w1Z:p2", status: "done" }] as StreamedChange[]);
    }, 150);

    const { lines } = await runWatch({ collectLines: 2, timeoutMs: 2500 });

    const emitted = lines.map((l) => JSON.parse(l).pane_id);
    expect(emitted).toContain("w1Z:p1");
    expect(emitted).toContain("w1Z:p2");
  });
});

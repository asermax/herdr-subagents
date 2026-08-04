import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChild } from "../src/helper/collect.js";
import { spawnChild, type SpawnFailure } from "../src/helper/spawn.js";

async function expectFail<T>(p: Promise<T>): Promise<SpawnFailure> {
  try {
    await p;
  } catch (e) {
    return e as SpawnFailure;
  }
  throw new Error("expected spawn to fail");
}
import type { AgentSnapshot } from "../src/helper/herdr-types.js";
import { fileRegistryStore, Registry, type RegistryEntry, type RegistryStore } from "../src/helper/registry.js";
import { StubHerdrServer, type ScriptedEvent } from "./stub-server.js";
import { FakeHerdrClient } from "./fake-client.js";

let server: StubHerdrServer;
let tmpDir: string;
let registryPath: string;

function makeSnapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    pane_id: "w1Z:p1",
    tab_id: "w1Z:t1",
    workspace_id: "w1Z",
    name: "doer",
    agent: "pi",
    agent_status: "idle",
    state_change_seq: 1,
    ...over,
  };
}

beforeEach(async () => {
  server = new StubHerdrServer();
  await server.start();
  tmpDir = mkdtempSync(join(tmpdir(), "herdr-test-"));
  registryPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRegistry(client: FakeHerdrClient) {
  return new Registry(fileRegistryStore(registryPath), (id) => client.agentGet(id));
}

function defaultSpawnInput(over: Record<string, unknown> = {}) {
  return {
    kind: "pi" as const,
    agentName: "doer",
    label: "do the thing",
    cwd: "/repo",
    workspaceId: "w1Z",
    body: "<supervisor-agent>do the thing</supervisor-agent>",
    ...over,
  };
}

// --- spawn: tab creation ------------------------------------------------

describe("spawn tab creation", () => {
  it("creates the tab with the gate in env, no focus, and the final label", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = {
      "w1Z:p1": makeSnapshot({ state_change_seq: 5 }),
    };
    // The prompt delivery: after the prompt, a status change arrives.
    server.script([
      { paneId: "w1Z:p1", status: "working", seq: 6 } as ScriptedEvent,
    ]);

    const result = await spawnChild(defaultSpawnInput(), {
      client,
      bounds: { deliveryStallMs: 1000 },
    });

    const createCall = client.calls.find((c) => c.method === "tab.create")!;
    expect(createCall.args.focus).toBe(false);
    expect(createCall.args.label).toBe("do the thing");
    expect(createCall.args.env).toEqual({ HERDR_SUBAGENT: "1" });
    expect(result.pane_id).toBe("w1Z:p1");
  });
});

// --- spawn: dev-loop forwarding (spec §9) ------------------------------
// A parent under development passes the same flags to its children; production
// passes nothing. Env forwarding is always-on (HERDR_SUBAGENT_* prefix); argv
// forwarding is the complement of spawn's own flags.

describe("spawn dev-loop forwarding", () => {
  it("forwards HERDR_SUBAGENT_* env to the child tab alongside the gate", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ state_change_seq: 5 }) };
    server.script([{ paneId: "w1Z:p1", status: "working", seq: 6 }]);

    await spawnChild(
      defaultSpawnInput({
        passThroughEnv: {
          HERDR_SUBAGENT: "1",
          HERDR_SUBAGENT_HELPER: "/repo/build/out/pi/herdr-helper",
        },
      }),
      { client, bounds: { deliveryStallMs: 1000 } },
    );

    const createCall = client.calls.find((c) => c.method === "tab.create")!;
    expect(createCall.args.env).toEqual({
      HERDR_SUBAGENT: "1",
      HERDR_SUBAGENT_HELPER: "/repo/build/out/pi/herdr-helper",
    });
  });

  it("forwards passThroughArgs onto the child agent-start argv after --agent", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ state_change_seq: 5 }) };
    server.script([{ paneId: "w1Z:p1", status: "working", seq: 6 }]);

    await spawnChild(
      defaultSpawnInput({
        passThroughArgs: ["--extension", "/repo/src/extension/index.ts", "--skill", "/repo/build/out/pi/skills"],
      }),
      { client, bounds: { deliveryStallMs: 1000 } },
    );

    const startCall = client.calls.find((c) => c.method === "agent.start")!;
    expect(startCall.args.args).toEqual([
      "--agent", "doer",
      "--extension", "/repo/src/extension/index.ts",
      "--skill", "/repo/build/out/pi/skills",
    ]);
  });
});

// --- spawn: verify-and-rename (2-of-4 case) -----------------------------

describe("spawn verify-and-rename", () => {
  it("verifies the name and renames when the stub reports it missing", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    // Name is missing on the first get (seq 5), but present after one rename.
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ state_change_seq: 5 }) };
    // First get reports no name; after a rename, the name lands.
    client.opts.nameAfterRename = {
      "w1Z:p1": (attempts) => (attempts === 0 ? "" : "doer"),
    };
    server.script([{ paneId: "w1Z:p1", status: "working", seq: 6 }]);

    await spawnChild(defaultSpawnInput(), {
      client,
      bounds: { deliveryStallMs: 1000 },
    });

    const renames = client.calls.filter((c) => c.method === "agent.rename");
    expect(renames.length).toBe(1);
    expect(renames[0]!.args.name).toBe("doer");
  });

  it("exhausts rename attempts and reports failure, closing the tab", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ state_change_seq: 5 }) };
    // Name never lands.
    client.opts.nameAfterRename = { "w1Z:p1": () => "" };

    const failure = await expectFail(
      spawnChild(defaultSpawnInput(), { client, bounds: { maxRenameAttempts: 2, deliveryStallMs: 1000 } }),
    );

    expect(failure.reason).toBe("name");
    // The half-created tab was closed.
    const closes = client.calls.filter((c) => c.method === "tab.close");
    expect(closes.length).toBe(1);
    expect(failure.pane_id).toBe("w1Z:p1");
  });

  it("does not rename a pane that is briefly not detected, and recovers", async () => {
    const client = new FakeHerdrClient({
      socketPath: server.socketPath,
      snapshots: { "w1Z:p1": makeSnapshot({ state_change_seq: 5 }) },
      // First get reports `unknown` (transient detection-loss); the next detects.
      snapshotByGetIndex: {
        "w1Z:p1": (idx) => (idx === 1 ? { agent_status: "unknown" } : undefined),
      },
    });
    server.script([{ paneId: "w1Z:p1", status: "working", seq: 6 }]);

    await spawnChild(defaultSpawnInput(), { client, bounds: { deliveryStallMs: 1000 } });

    // No rename attempted on a not-detected pane (it would fail and close the tab).
    const renames = client.calls.filter((c) => c.method === "agent.rename");
    expect(renames).toHaveLength(0);
    const closes = client.calls.filter((c) => c.method === "tab.close");
    expect(closes).toHaveLength(0);
  });
});

// --- spawn: verify-delivery (7-of-8 case) -------------------------------

describe("spawn verify-delivery", () => {
  it("resends when the stub reports no status change in the stall window", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ state_change_seq: 5 }) };
    // First prompt: no event matches in the window (dropped). The resend
    // (attempt 2) finds a delivery.
    server.script([
      { paneId: "w1Z:p1", status: "working", seq: 6, deliverOnAttempt: 2 } as ScriptedEvent,
    ]);

    await spawnChild(defaultSpawnInput(), {
      client,
      bounds: { deliveryStallMs: 50, maxPromptAttempts: 3 },
    });

    const prompts = client.calls.filter((c) => c.method === "agent.prompt");
    expect(prompts.length).toBeGreaterThanOrEqual(2);
  });

  it("exhausts delivery attempts and reports failure, closing the tab", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ state_change_seq: 5 }) };
    // No events ever — every prompt looks dropped.
    server.script([]);

    const failure = await expectFail(
      spawnChild(defaultSpawnInput(), { client, bounds: { deliveryStallMs: 50, maxPromptAttempts: 2 } }),
    );

    expect(failure.reason).toBe("delivery");
    const closes = client.calls.filter((c) => c.method === "tab.close");
    expect(closes.length).toBe(1);
  });
});

// --- spawn: readiness failure shapes ------------------------------------

describe("spawn readiness classification", () => {
  it("distinguishes a readiness timeout from a fast post-start failure", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });

    // timeout: harness never ready.
    client.opts.startResult = {
      doer: { error: { code: "agent_start_timeout", message: "never ready" } },
    };
    const timeoutFail = await expectFail(spawnChild(defaultSpawnInput(), {
      client,
      bounds: { readinessTimeoutMs: 50 },
    }));
    expect(timeoutFail.reason).toBe("timeout");

    // fast-fail: started and exited.
    client.opts.startResult = {
      doer: { error: { code: "agent_exited", message: "claude exited" } },
    };
    client.calls.length = 0;
    const fastFail = await expectFail(spawnChild(defaultSpawnInput(), {
      client,
      bounds: { readinessTimeoutMs: 50 },
    }));
    expect(fastFail.reason).toBe("fast-fail");
    expect(fastFail.message).toContain("claude exited");
  });

  it("closes the half-created tab on a readiness failure", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.startResult = {
      doer: { error: { code: "agent_start_timeout", message: "never ready" } },
    };
    await spawnChild(defaultSpawnInput(), { client, bounds: { readinessTimeoutMs: 50 } }).catch(
      () => {},
    );
    const closes = client.calls.filter((c) => c.method === "tab.close");
    expect(closes.length).toBe(1);
  });
});

// --- collect ------------------------------------------------------------

describe("collect", () => {
  it("returns the last assistant message from a pi session-log path", async () => {
    const logPath = join(tmpDir, "pi-session.jsonl");
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "session",
          id: "s1",
          timestamp: "t0",
          cwd: "/repo",
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          timestamp: "t1",
          message: { role: "user", content: "do the thing" },
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          timestamp: "t2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "did the thing" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = {
      "w1Z:p1": makeSnapshot({
        agent_status: "done",
        agent_session: { kind: "path", value: logPath },
      }),
    };
    const registry = makeRegistry(client);
    await registry.add({
      pane_id: "w1Z:p1",
      tab_id: "w1Z:t1",
      workspace_id: "w1Z",
      label: "do the thing",
      agent: "doer",
      kind: "pi",
      agent_name: "doer",
      status: "idle",
    });

    const payload = await collectChild("w1Z:p1", { client, registry });

    expect(payload).toEqual({
      pane_id: "w1Z:p1",
      label: "do the thing",
      agent: "doer",
      status: "done",
      message: "did the thing",
      ask: false,
    });
  });

  it("returns the last assistant message from a claude session uuid", async () => {
    const logPath = join(tmpDir, "claude-session.jsonl");
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "do the thing" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "did the thing" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = {
      "w1Z:p1": makeSnapshot({
        agent_status: "done",
        agent_session: { kind: "id", value: "uuid-123" },
      }),
    };
    const registry = makeRegistry(client);
    await registry.add({
      pane_id: "w1Z:p1",
      tab_id: "w1Z:t1",
      workspace_id: "w1Z",
      label: "do the thing",
      agent: "doer",
      kind: "claude",
      agent_name: "doer",
      status: "idle",
    });

    const payload = await collectChild("w1Z:p1", {
      client,
      registry,
      resolveClaudeSession: () => logPath,
    });

    expect(payload.message).toBe("did the thing");
    expect(payload.status).toBe("done");
  });

  it("surfaces <subagent-ask> distinguishably from a plain result", async () => {
    const logPath = join(tmpDir, "ask.jsonl");
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "message",
          id: "m1",
          timestamp: "t1",
          message: { role: "user", content: "do it" },
        }),
        JSON.stringify({
          type: "message",
          id: "m2",
          timestamp: "t2",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Which branch?\n<subagent-ask>main or ticket-17?</subagent-ask>" },
            ],
          },
        }),
      ].join("\n") + "\n",
    );

    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = {
      "w1Z:p1": makeSnapshot({
        agent_status: "done",
        agent_session: { kind: "path", value: logPath },
      }),
    };
    const registry = makeRegistry(client);
    await registry.add({
      pane_id: "w1Z:p1",
      tab_id: "w1Z:t1",
      workspace_id: "w1Z",
      label: "do the thing",
      agent: "doer",
      kind: "pi",
      agent_name: "doer",
      status: "idle",
    });

    const payload = await collectChild("w1Z:p1", { client, registry });
    expect(payload.ask).toBe(true);
    expect(payload.message).toContain("<subagent-ask>");
  });

  it("retries then succeeds on a lagging claude transcript", async () => {
    const logPath = join(tmpDir, "lagging.jsonl");
    // Initially the transcript has only an incomplete assistant entry.
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", stop_reason: null, content: [] },
        }),
      ].join("\n") + "\n",
    );

    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = {
      "w1Z:p1": makeSnapshot({
        agent_status: "done",
        agent_session: { kind: "id", value: "uuid-lag" },
      }),
    };
    const registry = makeRegistry(client);
    await registry.add({
      pane_id: "w1Z:p1",
      tab_id: "w1Z:t1",
      workspace_id: "w1Z",
      label: "do the thing",
      agent: "doer",
      kind: "claude",
      agent_name: "doer",
      status: "idle",
    });

    // After a couple of retries, the complete message lands.
    let reads = 0;
    const readText = (p: string) => {
      reads++;
      if (reads >= 2) {
        writeFileSync(
          p,
          [
            JSON.stringify({
              type: "assistant",
              message: {
                role: "assistant",
                stop_reason: "end_turn",
                content: [{ type: "text", text: "finally done" }],
              },
            }),
          ].join("\n") + "\n",
        );
      }
      return require("node:fs").readFileSync(p, "utf8");
    };

    const payload = await collectChild("w1Z:p1", {
      client,
      registry,
      resolveClaudeSession: () => logPath,
      readText,
      transcriptRetryMs: 10,
      transcriptAttempts: 6,
    });

    expect(payload.message).toBe("finally done");
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("treats a missing stop_reason as incomplete, not complete", async () => {
    const logPath = join(tmpDir, "missing-stop.jsonl");
    // Newest entry omits stop_reason (a mid-stream flush variant); the older
    // one is complete. Collect must skip the mid-stream entry and return the
    // prior complete message.
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "the complete turn" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "mid-stream, no stop_reason" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = {
      "w1Z:p1": makeSnapshot({
        agent_status: "done",
        agent_session: { kind: "id", value: "uuid-missing" },
      }),
    };
    const registry = makeRegistry(client);
    await registry.add({
      pane_id: "w1Z:p1",
      tab_id: "w1Z:t1",
      workspace_id: "w1Z",
      label: "do the thing",
      agent: "doer",
      kind: "claude",
      agent_name: "doer",
      status: "idle",
    });

    const payload = await collectChild("w1Z:p1", {
      client,
      registry,
      resolveClaudeSession: () => logPath,
    });

    expect(payload.message).toBe("the complete turn");
  });

  it("returns blocked status without a message", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = {
      "w1Z:p1": makeSnapshot({ agent_status: "blocked" }),
    };
    const registry = makeRegistry(client);
    await registry.add({
      pane_id: "w1Z:p1",
      tab_id: "w1Z:t1",
      workspace_id: "w1Z",
      label: "do the thing",
      agent: "doer",
      kind: "pi",
      agent_name: "doer",
      status: "idle",
    });

    const payload = await collectChild("w1Z:p1", { client, registry });
    expect(payload.status).toBe("blocked");
    expect(payload.message).toBeUndefined();
  });
});

// --- list stale detection ----------------------------------------------

describe("list stale detection", () => {
  it("marks entries stale (not live) after an id renumber", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    // After a restart the old pane id no longer resolves.
    client.opts.snapshots = {};
    const registry = makeRegistry(client);
    await registry.add({
      pane_id: "w1Z:p9",
      tab_id: "w1Z:t9",
      workspace_id: "w1Z",
      label: "old child",
      agent: "doer",
      kind: "pi",
      agent_name: "doer",
      status: "done",
    });

    const children = await registry.list();
    expect(children).toHaveLength(1);
    const child = children[0]!;
    expect(child.stale).toBe(true);
    expect(child.pane_id).toBe("w1Z:p9");
  });

  it("reports live children with refreshed status", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = {
      "w1Z:p2": makeSnapshot({
        pane_id: "w1Z:p2",
        tab_id: "w1Z:t2",
        agent_status: "done",
      }),
    };
    const registry = makeRegistry(client);
    await registry.add({
      pane_id: "w1Z:p2",
      tab_id: "w1Z:t2",
      workspace_id: "w1Z",
      label: "live child",
      agent: "doer",
      kind: "pi",
      agent_name: "doer",
      status: "idle",
    });

    const children = await registry.list();
    const child = children[0]!;
    expect(child.stale).toBe(false);
    expect(child.status).toBe("done");
  });
});

// --- registry serialization (read-modify-write guard) ------------------

// A store that yields a tick on both read and write, so concurrent
// read-modify-write spans overlap unless the registry serializes them. Tracks
// how many spans ran at once.
function yieldingStore(): {
  store: RegistryStore;
  maxActive: () => number;
  entries: () => Record<string, RegistryEntry>;
} {
  let data: Record<string, RegistryEntry> = {};
  let active = 0;
  let maxActive = 0;
  const store: RegistryStore = {
    async read() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 1));
      return { ...data };
    },
    async write(entries: Record<string, RegistryEntry>) {
      await new Promise((r) => setTimeout(r, 1));
      data = { ...entries };
      active -= 1;
    },
  };
  return { store, maxActive: () => maxActive, entries: () => data };
}

function makeRegistryEntry(paneId: string): RegistryEntry {
  return {
    pane_id: paneId,
    tab_id: `w1Z:t-${paneId}`,
    workspace_id: "w1Z",
    label: paneId,
    agent: "doer",
    kind: "pi",
    agent_name: "doer",
    status: "idle",
  };
}

describe("registry serialization", () => {
  it("does not lose concurrent adds to overlapping read-modify-write", async () => {
    const { store, maxActive, entries } = yieldingStore();
    const registry = new Registry(store, async () => null);

    await Promise.all([
      registry.add(makeRegistryEntry("w1Z:p1")),
      registry.add(makeRegistryEntry("w1Z:p2")),
      registry.add(makeRegistryEntry("w1Z:p3")),
      registry.add(makeRegistryEntry("w1Z:p4")),
    ]);

    // Without serialization, each overlapping read sees the empty snapshot and
    // the last writer clobbers the rest.
    const ids = Object.keys(entries());
    expect(ids).toHaveLength(4);
    expect(ids).toEqual(
      expect.arrayContaining(["w1Z:p1", "w1Z:p2", "w1Z:p3", "w1Z:p4"]),
    );
    // No two read-modify-write spans overlapped.
    expect(maxActive()).toBe(1);
  });

  it("serializes setStatus against a concurrent add so neither update is lost", async () => {
    const { store, maxActive, entries } = yieldingStore();
    const registry = new Registry(store, async () => null);
    await registry.add(makeRegistryEntry("w1Z:p1"));

    await Promise.all([
      registry.add(makeRegistryEntry("w1Z:p2")),
      registry.setStatus("w1Z:p1", "done"),
    ]);

    const ids = Object.keys(entries()).sort();
    expect(ids).toEqual(["w1Z:p1", "w1Z:p2"]);
    expect(entries()["w1Z:p1"]!.status).toBe("done");
    expect(maxActive()).toBe(1);
  });
});

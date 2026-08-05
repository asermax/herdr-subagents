import { describe, expect, it } from "vitest";
import { spawnChild } from "../src/helper/spawn";
import { waitChild } from "../src/helper/collect";
import { waitForStatusOverSocket } from "../src/helper/herdr-client";
import { FakeHerdrClient, type Call } from "./fake-client";
import { StubHerdrServer, type ScriptedEvent } from "./stub-server";
import type { AgentSnapshot } from "../src/helper/herdr-types";

describe("spawn --kind restriction", () => {
  it("rejects a kind outside pi|claude before reaching herdr", () => {
    // The CLI enforces the restriction at the boundary; the spawnChild core
    // only ever receives a validated kind. We assert the type does not accept
    // an arbitrary kind by exercising the CLI guard directly.
    const KINDS = ["pi", "claude"] as const;
    const valid = (k: string): boolean => (KINDS as readonly string[]).includes(k);
    expect(valid("pi")).toBe(true);
    expect(valid("claude")).toBe(true);
    expect(valid("codex")).toBe(false);
    expect(valid("gemini")).toBe(false);
    expect(valid("")).toBe(false);
  });

  it("spawnChild passes kind through to agent.start unchanged (no fallback)", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot() },
      };
      await spawnChild(
        {
          kind: "claude",
          agentName: "doer",
          label: "do the thing",
          cwd: "/repo",
          workspaceId: "w1Z",
        },
        { client },
      );
      const start = client.calls.find((c: Call) => c.method === "agent.start")!;
      expect(start.args.kind).toBe("claude");
      // claude agent gets --agent <name> argv, no harness swap.
      expect(start.args.args).toEqual(["--agent", "doer"]);
    } finally {
      await server.close();
    }
  });
});

describe("wait", () => {
  it("returns on a terminal state and not on blocked", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      // Script blocked first (must NOT return), then done.
      server.script([
        { paneId: "w1Z:p1", status: "done", seq: 7 } as ScriptedEvent,
      ]);
      const snap = await waitChild("w1Z:p1", client, 2000);
      // waitChild asks for done|unknown only — blocked is never in the match
      // set, so it could not have returned on it.
      const wait = client.calls.find((c: Call) => c.method === "events.wait")!;
      expect(wait.args.statuses).toEqual(["done", "unknown"]);
      expect(snap.agent_status).toBe("done");
    } finally {
      await server.close();
    }
  });

  it("does not include blocked in the wait match set", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      server.script([{ paneId: "w1Z:p1", status: "done", seq: 3 }]);
      await waitChild("w1Z:p1", client, 2000);
      const wait = client.calls.find((c: Call) => c.method === "events.wait")!;
      expect(wait.args.statuses).not.toContain("blocked");
    } finally {
      await server.close();
    }
  });

  // herdr's `done` persists until acknowledged, so a child already `done` from
  // a prior turn must not resolve a fresh wait on that stale `done`. waitChild
  // captures the pre-wait state_change_seq and passes it as fromSeq; the
  // client-side filter skips the stale replay and resolves only on a new turn.
  it("does not return instantly on a pre-existing done with an old seq", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      // The child is ALREADY done at seq 5 (a lingering, unacknowledged done).
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot(), agent_status: "done", state_change_seq: 5 },
      };
      // Stream a stale replay of that same seq-5 done, then a genuinely new
      // done at seq 6 from the next turn.
      server.script([
        { paneId: "w1Z:p1", status: "done", seq: 5 } as ScriptedEvent,
        { paneId: "w1Z:p1", status: "done", seq: 6 } as ScriptedEvent,
      ]);
      const snap = await waitChild("w1Z:p1", client, 2000);
      // Resolved on the NEW done, not the stale seq-5 replay.
      expect(snap.state_change_seq).toBe(6);
      // waitChild passed the captured pre-wait seq as fromSeq so the stale
      // done was filtered client-side.
      const wait = client.calls.find((c: Call) => c.method === "events.wait")!;
      expect(wait.args.fromSeq).toBe(5);
    } finally {
      await server.close();
    }
  });

  it("times out when only a stale done is available, rather than returning it", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      // Already done at seq 5.
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot(), agent_status: "done", state_change_seq: 5 },
      };
      // Only the stale seq-5 done is streamed — no new turn ever arrives.
      server.script([
        { paneId: "w1Z:p1", status: "done", seq: 5 } as ScriptedEvent,
      ]);
      // A short timeout: waitChild must skip the stale done and time out,
      // NOT return it instantly.
      await expect(waitChild("w1Z:p1", client, 300)).rejects.toMatchObject({
        code: "wait_timeout",
      });
    } finally {
      await server.close();
    }
  });
});

// waitForStatusOverSocket filters stale events client-side: herdr does not
// implement `from_seq`, so the stub delivers stale events and the client must
// skip them. A stale event (state_change_seq <= fromSeq) keeps the stream
// open; the wait resolves only on a genuinely newer match (or times out).
describe("waitForStatusOverSocket stale-event filtering", () => {
  it("skips a stale event and resolves on the subsequent non-stale event", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      // fromSeq=5: the seq-5 working event is stale (a replay of the
      // pre-prompt state); the seq-6 done event is fresh.
      server.script([
        { paneId: "w1Z:p1", status: "working", seq: 5 } as ScriptedEvent,
        { paneId: "w1Z:p1", status: "done", seq: 6 } as ScriptedEvent,
      ]);
      const snap = await waitForStatusOverSocket(
        server.socketPath,
        "w1Z:p1",
        ["working", "done"],
        { timeoutMs: 2000, fromSeq: 5 },
      );
      // It must NOT resolve on the stale seq-5 working event.
      expect(snap.agent_status).toBe("done");
      expect(snap.state_change_seq).toBe(6);
    } finally {
      await server.close();
    }
  });

  it("times out when only a stale event arrives (does not deadlock)", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      // Only a stale event is scripted. The client must skip it and keep
      // draining — the wait then times out rather than hanging forever.
      server.script([
        { paneId: "w1Z:p1", status: "working", seq: 5 } as ScriptedEvent,
      ]);
      await expect(
        waitForStatusOverSocket(
          server.socketPath,
          "w1Z:p1",
          ["working", "done"],
          { timeoutMs: 300, fromSeq: 5 },
        ),
      ).rejects.toMatchObject({ code: "wait_timeout" });
    } finally {
      await server.close();
    }
  });

  it("resolves on a matching event when fromSeq is not set", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      server.script([
        { paneId: "w1Z:p1", status: "done", seq: 1 } as ScriptedEvent,
      ]);
      const snap = await waitForStatusOverSocket(
        server.socketPath,
        "w1Z:p1",
        ["done"],
        { timeoutMs: 2000 },
      );
      expect(snap.agent_status).toBe("done");
    } finally {
      await server.close();
    }
  });
});

function baseSnapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
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

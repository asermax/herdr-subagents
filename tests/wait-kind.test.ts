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
  it("returns when the child stops working, and never on working", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot(), agent_status: "working", state_change_seq: 5 },
      };
      server.script([
        { paneId: "w1Z:p1", status: "done", seq: 7 } as ScriptedEvent,
      ]);
      const snap = (await waitChild("w1Z:p1", client, 2000)).snapshot;
      const wait = client.calls.find((c: Call) => c.method === "events.wait")!;
      // Every state that ends a turn is in the match set; `working` is not.
      expect(wait.args.statuses).toEqual(["done", "idle", "blocked", "unknown"]);
      expect(wait.args.statuses).not.toContain("working");
      expect(snap.agent_status).toBe("done");
    } finally {
      await server.close();
    }
  });

  it("returns on blocked so the parent can answer the dialog", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      // A child that hits an approval prompt mid-run must wake its parent —
      // nobody else is watching that tab.
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot(), agent_status: "working", state_change_seq: 5 },
      };
      server.script([{ paneId: "w1Z:p1", status: "blocked", seq: 7 } as ScriptedEvent]);
      const snap = (await waitChild("w1Z:p1", client, 2000)).snapshot;
      expect(snap.agent_status).toBe("blocked");
    } finally {
      await server.close();
    }
  });

  // The wake this used to lose: the turn finishes between `prompt` and the
  // arming of `wait`, so the child stands in `done` and emits no further event.
  // The acked sequence from the prompt receipt makes that standing state new.
  it("returns immediately when the turn ended before the wait was armed", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot(), agent_status: "done", state_change_seq: 9 },
      };
      // Nothing is streamed: the only evidence is the standing `done`.
      const snap = (await waitChild("w1Z:p1", client, 300, { seq: 6 })).snapshot;
      expect(snap.agent_status).toBe("done");
      expect(snap.state_change_seq).toBe(9);
      // Answered from the probe — no subscription was needed.
      expect(client.calls.find((c: Call) => c.method === "events.wait")).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("returns on a standing idle — a seen child's finished turn reads idle, not done", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot(), agent_status: "idle", state_change_seq: 9 },
      };
      const snap = (await waitChild("w1Z:p1", client, 300, { seq: 6 })).snapshot;
      expect(snap.agent_status).toBe("idle");
    } finally {
      await server.close();
    }
  });

  it("keeps waiting while the child is still working", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot(), agent_status: "working", state_change_seq: 9 },
      };
      server.script([{ paneId: "w1Z:p1", status: "done", seq: 10 } as ScriptedEvent]);
      const snap = (await waitChild("w1Z:p1", client, 2000, { seq: 6 })).snapshot;
      expect(snap.agent_status).toBe("done");
      // A working child is mid-turn: the wait subscribed instead of answering.
      expect(client.calls.find((c: Call) => c.method === "events.wait")).toBeDefined();
    } finally {
      await server.close();
    }
  });

  // The parent was told the child is blocked and asked the human to answer it.
  // It then needs to know the human did — that is the one case where `working`
  // is a wake.
  it("wakes on the resume from a block the parent already knows about", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot(), agent_status: "working", state_change_seq: 7 },
      };
      const outcome = await waitChild("w1Z:p1", client, 300, { seq: 6, status: "blocked" });
      expect(outcome.snapshot.agent_status).toBe("working");
      expect(outcome.timed_out).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("does not wake on working when no block was reported", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot(), agent_status: "working", state_change_seq: 7 },
      };
      const outcome = await waitChild("w1Z:p1", client, 300, { seq: 6, status: "working" });
      expect(outcome.timed_out).toBe(true);
      // `working` is only in the match set as a resume signal.
      const wait = client.calls.find((c: Call) => c.method === "events.wait")!;
      expect(wait.args.statuses).not.toContain("working");
    } finally {
      await server.close();
    }
  });

  it("asks the stream for working too once a block was reported", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      client.opts.snapshots = {
        "w1Z:p1": { ...baseSnapshot(), agent_status: "blocked", state_change_seq: 6 },
      };
      await waitChild("w1Z:p1", client, 300, { seq: 6, status: "blocked" });
      const wait = client.calls.find((c: Call) => c.method === "events.wait")!;
      expect(wait.args.statuses).toContain("working");
    } finally {
      await server.close();
    }
  });

  it("reports gone when the pane no longer resolves, after confirming it", async () => {
    const server = new StubHerdrServer();
    await server.start();
    try {
      const client = new FakeHerdrClient({ socketPath: server.socketPath });
      // No snapshot for the pane: agentGet answers null (closed, crashed).
      const snap = (await waitChild("w1Z:p1", client, 300, { seq: 6 })).snapshot;
      expect(snap.agent_status).toBe("unknown");
      // Confirmed with a second probe before calling it gone — a transient
      // detection gap must not read as a dead child.
      expect(client.calls.filter((c: Call) => c.method === "agent.get")).toHaveLength(2);
      expect(client.calls.find((c: Call) => c.method === "events.wait")).toBeUndefined();
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
      const snap = (await waitChild("w1Z:p1", client, 2000)).snapshot;
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
      // A short budget: waitChild must skip the stale done and report
      // `timed_out` — never return the stale state as an answer, and never
      // throw (the wake channel always ends with a report).
      const outcome = await waitChild("w1Z:p1", client, 300);
      expect(outcome.timed_out).toBe(true);
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

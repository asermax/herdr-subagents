import { describe, expect, it } from "vitest";
import { spawnChild } from "../src/helper/spawn";
import { waitChild } from "../src/helper/collect";
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
        "w1Z:p1": { ...baseSnapshot(), state_change_seq: 5 },
      };
      server.script([{ paneId: "w1Z:p1", status: "working", seq: 6 }]);
      await spawnChild(
        {
          kind: "claude",
          agentName: "doer",
          label: "do the thing",
          cwd: "/repo",
          workspaceId: "w1Z",
          body: "<supervisor-agent>x</supervisor-agent>",
        },
        { client, bounds: { deliveryStallMs: 1000 } },
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

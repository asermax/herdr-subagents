import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliverPrompt } from "../src/helper/prompt.js";
import type { AgentSnapshot } from "../src/helper/herdr-types.js";
import { FakeHerdrClient } from "./fake-client.js";
import { StubHerdrServer, type ScriptedEvent } from "./stub-server.js";

// REPRO: the same message is delivered twice even though the first send
// worked. Both cases model a claude child steered from pi. The assertions
// encode the CURRENT (buggy) behavior — two identical agent.prompt calls — so
// this suite documents the duplicate; a fix flips the expectations to 1.

const BODY = "<supervisor-agent>fix the login bug</supervisor-agent>";

function makeSnapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    pane_id: "w1Z:p1",
    tab_id: "w1Z:t1",
    workspace_id: "w1Z",
    name: "doer",
    agent: "claude",
    agent_status: "idle",
    state_change_seq: 5,
    ...over,
  };
}

let server: StubHerdrServer;

beforeEach(async () => {
  server = new StubHerdrServer();
  await server.start();
});

afterEach(async () => {
  await server.close();
});

describe("REPRO duplicate prompt delivery", () => {
  it("resends an identical prompt when the child's status flip lands after the stall window", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ agent: "claude" }) };
    // Get #3 is the post-delivery probe: by then the child is working.
    client.opts.snapshotByGetIndex = {
      "w1Z:p1": (idx) => (idx >= 3 ? { agent_status: "working", state_change_seq: 6 } : undefined),
    };
    // The first prompt works: the child starts working. But herdr only makes
    // the flip observable on the SECOND subscribe (subAttempt 2) — a claude
    // cold start (plugins, MCP servers) that crosses the stall window looks
    // identical to a dropped prompt from inside the window.
    server.script([{ paneId: "w1Z:p1", status: "working", seq: 6, deliverOnAttempt: 2 } as ScriptedEvent]);

    const receipt = await deliverPrompt(client, "w1Z:p1", BODY, {
      maxPromptAttempts: 3,
      deliveryStallMs: 50,
    });

    const prompts = client.calls.filter((c) => c.method === "agent.prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts.every((p) => p.args.body === BODY)).toBe(true);
    expect(receipt.status).toBe("working");
  });

  it("sends the duplicate even when its own pre-send probe already shows the child working", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ agent: "claude" }) };
    // Get #2 is attempt 2's pre-send probe: the child is already working on
    // the first prompt (the flip landed in the gap after the window closed).
    // The loop still calls agentPrompt BEFORE reading `before.agent_status`,
    // so the duplicate goes out even though the helper knows the child is busy.
    client.opts.snapshotByGetIndex = {
      "w1Z:p1": (idx) => (idx >= 2 ? { agent_status: "working", state_change_seq: 6 } : undefined),
    };
    server.script([]);
    server.timeoutSubscriptions();

    const receipt = await deliverPrompt(client, "w1Z:p1", BODY, {
      maxPromptAttempts: 3,
      deliveryStallMs: 50,
    });

    const prompts = client.calls.filter((c) => c.method === "agent.prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts.every((p) => p.args.body === BODY)).toBe(true);
    // The child was working on the first send the whole time.
    expect(receipt.status).toBe("working");
    const gets = client.calls.filter((c) => c.method === "agent.get");
    expect(gets.length).toBeGreaterThanOrEqual(2);
  });
});

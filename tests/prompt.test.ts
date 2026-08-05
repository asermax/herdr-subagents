import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliverPrompt } from "../src/helper/prompt.js";
import type { SpawnFailure } from "../src/helper/spawn.js";
import type { AgentSnapshot } from "../src/helper/herdr-types.js";
import { FakeHerdrClient } from "./fake-client.js";
import { StubHerdrServer, type ScriptedEvent } from "./stub-server.js";

// prompt deliver-and-verify: the cases that used to live under spawn
// verify-delivery. spawn no longer delivers a prompt; deliverPrompt does, so
// the resend-and-exhaustion behavior is asserted here against the stub socket.

let server: StubHerdrServer;

async function expectFail<T>(p: Promise<T>): Promise<SpawnFailure> {
  try {
    await p;
  } catch (e) {
    return e as SpawnFailure;
  }
  throw new Error("expected deliverPrompt to fail");
}

function makeSnapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    pane_id: "w1Z:p1",
    tab_id: "w1Z:t1",
    workspace_id: "w1Z",
    name: "doer",
    agent: "pi",
    agent_status: "idle",
    state_change_seq: 5,
    ...over,
  };
}

beforeEach(async () => {
  server = new StubHerdrServer();
  await server.start();
});

afterEach(async () => {
  await server.close();
});

describe("prompt verify-delivery", () => {
  it("resolves on the first send when a status change lands in the window", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ state_change_seq: 5 }) };
    server.script([{ paneId: "w1Z:p1", status: "working", seq: 6 } as ScriptedEvent]);

    await deliverPrompt(client, "w1Z:p1", "<supervisor-agent>do it</supervisor-agent>", {
      maxPromptAttempts: 3,
      deliveryStallMs: 1000,
    });

    const prompts = client.calls.filter((c) => c.method === "agent.prompt");
    expect(prompts).toHaveLength(1);
  });

  it("resends a dropped first prompt and succeeds on the resend", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ state_change_seq: 5 }) };
    // First attempt: nothing matches in the window (dropped). The resend
    // (attempt 2) finds a delivery.
    server.script([
      { paneId: "w1Z:p1", status: "working", seq: 6, deliverOnAttempt: 2 } as ScriptedEvent,
    ]);

    await deliverPrompt(client, "w1Z:p1", "<supervisor-agent>do it</supervisor-agent>", {
      maxPromptAttempts: 3,
      deliveryStallMs: 50,
    });

    const prompts = client.calls.filter((c) => c.method === "agent.prompt");
    expect(prompts.length).toBeGreaterThanOrEqual(2);
  });

  it("exhausts delivery attempts and throws a delivery failure", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ state_change_seq: 5 }) };
    // No events ever — every prompt looks dropped.
    server.script([]);

    const failure = await expectFail(
      deliverPrompt(client, "w1Z:p1", "<supervisor-agent>do it</supervisor-agent>", {
        maxPromptAttempts: 2,
        deliveryStallMs: 50,
      }),
    );

    expect(failure.reason).toBe("delivery");
    const prompts = client.calls.filter((c) => c.method === "agent.prompt");
    expect(prompts).toHaveLength(2);
  });
});

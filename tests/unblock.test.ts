import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../src/helper/herdr-types.js";
import { isUnblockRefusal, unblockChild, type UnblockRefusal } from "../src/helper/unblock.js";
import { FakeHerdrClient } from "./fake-client.js";
import { StubHerdrServer } from "./stub-server.js";

// `unblock` answers a dialog a blocked child is stalled on. The interesting
// behavior is the guard (keys only ever reach a pane herdr reports `blocked`)
// and the honesty of the verdict (a wrong key leaves the child blocked, and
// the report says so with the pane attached).

let server: StubHerdrServer;

function makeSnapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    pane_id: "w1Z:p1",
    tab_id: "w1Z:t1",
    workspace_id: "w1Z",
    name: "doer",
    agent: "claude",
    agent_status: "blocked",
    state_change_seq: 3,
    ...over,
  };
}

async function expectRefusal<T>(p: Promise<T>): Promise<UnblockRefusal> {
  try {
    await p;
  } catch (e) {
    if (isUnblockRefusal(e)) return e;
    throw e;
  }
  throw new Error("expected unblockChild to refuse");
}

beforeEach(async () => {
  server = new StubHerdrServer();
  await server.start();
});

afterEach(async () => {
  await server.close();
});

describe("unblock", () => {
  it("sends the keys and reports the block cleared", async () => {
    const client = new FakeHerdrClient({
      socketPath: server.socketPath,
      snapshots: { "w1Z:p1": makeSnapshot() },
    });
    server.script([{ paneId: "w1Z:p1", status: "idle", seq: 9 }]);

    const result = await unblockChild(client, "w1Z:p1", ["1", "enter"], {
      clearStallMs: 500,
      screenLines: 40,
    });

    const keysCall = client.calls.find((c) => c.method === "agent.send-keys")!;
    expect(keysCall.args.keys).toEqual(["1", "enter"]);
    expect(result.cleared).toBe(true);
    expect(result.status).toBe("idle");
    // Nothing to show: the dialog is gone.
    expect(result.screen).toBeUndefined();
  });

  it("reports the child still blocked, with the pane, when the keys do not answer it", async () => {
    const client = new FakeHerdrClient({
      socketPath: server.socketPath,
      snapshots: { "w1Z:p1": makeSnapshot() },
      screens: { "w1Z:p1": "Do you want to proceed?\n❯ 1. Yes\n  2. No" },
    });

    const result = await unblockChild(client, "w1Z:p1", ["esc"], {
      clearStallMs: 100,
      screenLines: 40,
    });

    expect(result.cleared).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.screen).toMatch(/Do you want to proceed\?/);
  });

  it("refuses a pane that is not blocked, without sending keys", async () => {
    // Keys sent to an idle child land in its prompt box and corrupt the next
    // prompt, so the status is the gate.
    const client = new FakeHerdrClient({
      socketPath: server.socketPath,
      snapshots: { "w1Z:p1": makeSnapshot({ agent_status: "idle" }) },
    });

    const refusal = await expectRefusal(unblockChild(client, "w1Z:p1", ["enter"]));

    expect(refusal.reason).toBe("not-blocked");
    expect(refusal.status).toBe("idle");
    expect(client.calls.filter((c) => c.method === "agent.send-keys")).toHaveLength(0);
  });

  it("refuses a pane that no longer resolves as an agent", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });

    const refusal = await expectRefusal(unblockChild(client, "w1Z:p9", ["enter"]));

    expect(refusal.reason).toBe("gone");
    expect(client.calls.filter((c) => c.method === "agent.send-keys")).toHaveLength(0);
  });
});

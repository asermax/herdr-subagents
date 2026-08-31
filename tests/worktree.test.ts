import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeChild } from "../src/helper/close.js";
import type { AgentSnapshot } from "../src/helper/herdr-types.js";
import { fileRegistryStore, Registry } from "../src/helper/registry.js";
import { spawnChild, type SpawnFailure } from "../src/helper/spawn.js";
import { FakeHerdrClient } from "./fake-client.js";
import { StubHerdrServer } from "./stub-server.js";

let server: StubHerdrServer;
let tmpDir: string;
let registryPath: string;
let savedEnv: Record<string, string | undefined>;

function makeSnapshot(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    pane_id: "wt1:p1",
    tab_id: "wt1:t2",
    workspace_id: "wt1",
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
  tmpDir = mkdtempSync(join(tmpdir(), "herdr-wt-test-"));
  registryPath = join(tmpDir, "registry.json");
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("HERDR_SUBAGENT")) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
});

afterEach(async () => {
  await server.close();
  rmSync(tmpDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeRegistry(client: FakeHerdrClient) {
  return new Registry(fileRegistryStore(registryPath), (id) => client.agentGet(id));
}

function worktreeInput(over: Record<string, unknown> = {}) {
  return {
    kind: "pi" as const,
    agentName: "doer",
    label: "fix the bug",
    cwd: "/repo",
    workspaceId: "w1Z",
    worktree: {},
    ...over,
  };
}

async function expectFail<T>(p: Promise<T>): Promise<SpawnFailure> {
  try {
    await p;
  } catch (e) {
    return e as SpawnFailure;
  }
  throw new Error("expected spawn to fail");
}

// --- spawn: creating a worktree -----------------------------------------

describe("spawn into a new worktree", () => {
  it("creates the worktree, then the child's tab inside its workspace", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "wt1:p1": makeSnapshot() };

    const result = await spawnChild(worktreeInput(), { client });

    const create = client.calls.find((c) => c.method === "worktree.create")!;
    expect(create.args.branch).toBe("fix-the-bug");
    expect(create.args.workspaceId).toBe("w1Z");

    // The tab lands in the worktree's workspace, at the checkout, still gated.
    const tab = client.calls.find((c) => c.method === "tab.create")!;
    expect(tab.args.workspaceId).toBe("wt1");
    expect(tab.args.cwd).toBe("/worktrees/fix-the-bug");
    expect(tab.args.env).toEqual({ HERDR_SUBAGENT: "1" });
    expect(result.worktree).toEqual({ path: "/worktrees/fix-the-bug", branch: "fix-the-bug" });
  });

  it("closes herdr's root tab only after the child's tab exists", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "wt1:p1": makeSnapshot() };

    await spawnChild(worktreeInput(), { client });

    // Ordering is the point: closing first would empty the workspace.
    const order = client.methods();
    expect(order.indexOf("tab.create")).toBeLessThan(order.indexOf("tab.close"));
    expect(client.calls.find((c) => c.method === "tab.close")!.args.tabId).toBe("wt1:t0");
  });

  it("takes --branch and --base over the label", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "wt1:p1": makeSnapshot() };

    await spawnChild(
      worktreeInput({ worktree: { branch: "feat/login", base: "origin/main" } }),
      { client },
    );

    const create = client.calls.find((c) => c.method === "worktree.create")!;
    expect(create.args.branch).toBe("feat/login");
    expect(create.args.base).toBe("origin/main");
  });

  it("records the worktree on the registry entry", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "wt1:p1": makeSnapshot() };
    const registry = makeRegistry(client);

    await spawnChild(worktreeInput(), { client, tracking: registry });

    const [child] = await registry.list();
    expect(child!.workspace_id).toBe("wt1");
    expect(child!.worktree).toEqual({ path: "/worktrees/fix-the-bug", branch: "fix-the-bug" });
  });

  it("leaves no worktree behind when the spawn fails", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.snapshots = { "wt1:p1": makeSnapshot() };
    client.opts.startResult = { doer: { error: { code: "agent_start_timeout", message: "no" } } };

    const failure = await expectFail(spawnChild(worktreeInput(), { client }));

    expect(failure.reason).toBe("timeout");
    // The checkout goes with the tab: this spawn created it and no child is
    // left to use it.
    expect(client.calls.find((c) => c.method === "worktree.remove")!.args.workspaceId).toBe("wt1");
  });
});

// --- spawn: joining an existing worktree --------------------------------

describe("spawn into an existing worktree", () => {
  it("joins the open workspace of a branch already checked out", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.worktrees = [
      {
        path: "/worktrees/feat-login",
        branch: "feat/login",
        label: "repo",
        is_linked_worktree: true,
        open_workspace_id: "wtX",
      },
    ];
    client.opts.snapshots = { "wtX:p1": makeSnapshot({ pane_id: "wtX:p1", workspace_id: "wtX" }) };

    const result = await spawnChild(
      worktreeInput({ worktree: { branch: "feat/login" } }),
      { client },
    );

    // No second worktree forked off a branch that already has one.
    expect(client.methods()).not.toContain("worktree.create");
    expect(client.methods()).not.toContain("worktree.open");
    const tab = client.calls.find((c) => c.method === "tab.create")!;
    expect(tab.args.workspaceId).toBe("wtX");
    expect(tab.args.cwd).toBe("/worktrees/feat-login");
    expect(result.worktree).toEqual({ path: "/worktrees/feat-login", branch: "feat/login" });
  });

  it("does not close a tab it did not open when joining", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.worktrees = [
      {
        path: "/worktrees/feat-login",
        branch: "feat/login",
        label: "repo",
        is_linked_worktree: true,
        open_workspace_id: "wtX",
      },
    ];
    client.opts.snapshots = { "wtX:p1": makeSnapshot({ pane_id: "wtX:p1", workspace_id: "wtX" }) };

    await spawnChild(worktreeInput({ worktree: { branch: "feat/login" } }), { client });

    // The sibling's tab is not ours to close, and there is no root tab of ours.
    expect(client.methods()).not.toContain("tab.close");
  });

  it("opens a worktree that is checked out but has no workspace", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.worktrees = [
      {
        path: "/worktrees/feat-login",
        branch: "feat/login",
        label: "repo",
        is_linked_worktree: true,
      },
    ];
    client.opts.snapshots = { "wt1:p1": makeSnapshot() };

    await spawnChild(worktreeInput({ worktree: { branch: "feat/login" } }), { client });

    expect(client.calls.find((c) => c.method === "worktree.open")!.args.path).toBe(
      "/worktrees/feat-login",
    );
    expect(client.methods()).not.toContain("worktree.create");
  });

  it("keeps a joined worktree when the spawn fails", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    client.opts.worktrees = [
      {
        path: "/worktrees/feat-login",
        branch: "feat/login",
        label: "repo",
        is_linked_worktree: true,
        open_workspace_id: "wtX",
      },
    ];
    client.opts.snapshots = { "wtX:p1": makeSnapshot({ pane_id: "wtX:p1", workspace_id: "wtX" }) };
    client.opts.startResult = { doer: { error: { code: "agent_start_timeout", message: "no" } } };

    await expectFail(spawnChild(worktreeInput({ worktree: { branch: "feat/login" } }), { client }));

    // The checkout belongs to the siblings still in it — only our tab goes.
    expect(client.methods()).not.toContain("worktree.remove");
    expect(client.methods()).toContain("tab.close");
  });
});

// --- close: last one out takes the checkout -----------------------------

describe("close", () => {
  async function spawnTracked(client: FakeHerdrClient, registry: Registry) {
    client.opts.snapshots = { "wt1:p1": makeSnapshot() };
    return spawnChild(worktreeInput(), { client, tracking: registry });
  }

  it("removes the worktree when the child is the last tab in it", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    const registry = makeRegistry(client);
    const spawned = await spawnTracked(client, registry);
    client.opts.tabCounts = { wt1: 1 };

    const result = await closeChild(spawned.tab_id, { client, registry });

    expect(result.worktree_removed).toEqual({
      path: "/worktrees/fix-the-bug",
      branch: "fix-the-bug",
    });
    expect(client.calls.filter((c) => c.method === "worktree.remove")).toHaveLength(1);
    // worktree.remove takes the tab with it; closing it separately would fail.
    expect(client.calls.filter((c) => c.method === "tab.close" && c.args.tabId === spawned.tab_id))
      .toHaveLength(0);
    expect(await registry.list()).toHaveLength(0);
  });

  it("leaves the worktree alone while a sibling is still in it", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    const registry = makeRegistry(client);
    const spawned = await spawnTracked(client, registry);
    client.opts.tabCounts = { wt1: 2 };

    const result = await closeChild(spawned.tab_id, { client, registry });

    expect(result.worktree_removed).toBeUndefined();
    expect(client.methods()).not.toContain("worktree.remove");
    expect(client.calls.filter((c) => c.method === "tab.close" && c.args.tabId === spawned.tab_id))
      .toHaveLength(1);
  });

  it("keeps the child tracked when a dirty checkout refuses removal", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    const registry = makeRegistry(client);
    const spawned = await spawnTracked(client, registry);
    client.opts.tabCounts = { wt1: 1 };
    client.opts.worktreeRemoveError = {
      wt1: {
        code: "dirty_worktree_requires_force",
        message: "contains modified or untracked files",
      },
    };

    await expect(closeChild(spawned.tab_id, { client, registry })).rejects.toThrow(
      /dirty_worktree_requires_force/,
    );

    // Nothing was removed, so the child is still alive and must stay tracked
    // for the parent to prompt it to commit and close again.
    const [child] = await registry.list();
    expect(child!.pane_id).toBe(spawned.pane_id);
    // The child's own tab is untouched — only spawn's root-tab cleanup ran.
    expect(client.calls.filter((c) => c.method === "tab.close" && c.args.tabId === spawned.tab_id))
      .toHaveLength(0);
  });

  it("closes an ordinary child by tab, with no worktree lookup", async () => {
    const client = new FakeHerdrClient({ socketPath: server.socketPath });
    const registry = makeRegistry(client);
    client.opts.snapshots = { "w1Z:p1": makeSnapshot({ pane_id: "w1Z:p1", workspace_id: "w1Z" }) };
    const { worktree: _worktree, ...plain } = worktreeInput();
    const spawned = await spawnChild(plain, { client, tracking: registry });

    await closeChild(spawned.tab_id, { client, registry });

    expect(client.methods()).not.toContain("workspace.get");
    expect(client.methods()).not.toContain("worktree.remove");
    expect(client.methods()).not.toContain("worktree.list");
    expect(client.calls.filter((c) => c.method === "tab.close")).toHaveLength(1);
  });
});

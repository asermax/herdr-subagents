import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { emitArtifact } from "../build/emit.ts";
import { createWakeQueue, startParentRole, type WatchChunk } from "../src/claude/mod/parent-role.js";

// The Claude mod is driven as it ships: the built `hooks/register.js` imported
// and its hooks called with a fake engine. The bundle has no imports, so it
// loads here as it loads in Claude Code.

const PLUGIN_ROOT = mkdtempSync(join(tmpdir(), "herdr-claude-mod-"));
emitArtifact("claude", PLUGIN_ROOT);

afterAll(() => {
  rmSync(PLUGIN_ROOT, { recursive: true, force: true });
});

type HookFn = (...args: unknown[]) => unknown;

interface FakeOptions {
  env?: Record<string, string>;
  run?: (argv: readonly string[]) => { exitCode: number; stdout: string; stderr: string };
  watch?: () => AsyncIterable<WatchChunk>;
}

/** A controllable watch stream: push chunks, then end it. */
const controlledStream = () => {
  const queue: WatchChunk[] = [];
  let wakeUp: (() => void) | undefined;
  let ended = false;

  const stream: AsyncIterable<WatchChunk> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        while (queue.length === 0 && !ended) {
          await new Promise<void>((resolve) => (wakeUp = resolve));
        }
        const value = queue.shift();
        return value === undefined ? { done: true, value: undefined } : { done: false, value };
      },
      return: async () => {
        ended = true;
        wakeUp?.();
        return { done: true, value: undefined };
      },
    }),
  };

  return {
    stream,
    push: (text: string) => {
      queue.push({ stream: "stdout", text });
      wakeUp?.();
    },
    end: () => {
      ended = true;
      wakeUp?.();
    },
  };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function loadMod(options: FakeOptions = {}) {
  const url = pathToFileURL(join(PLUGIN_ROOT, "hooks/register.js")).href;
  const mod = (await import(`${url}?t=${Math.random()}`)) as {
    register: (on: (event: string, hook: HookFn) => unknown) => void;
  };

  const hooks = new Map<string, HookFn>();
  mod.register((event, hook) => {
    hooks.set(event, hook);
    return { catch: () => undefined };
  });

  const env = options.env ?? {};
  const $ = {
    plugin: { root: PLUGIN_ROOT },
    env: { get: vi.fn(async (name: string) => env[name]) },
    process: {
      run: vi.fn(async (argv: readonly string[]) =>
        options.run ? options.run(argv) : { exitCode: 0, stdout: "{}", stderr: "" },
      ),
      spawn: vi.fn(() => (options.watch ? options.watch() : controlledStream().stream)),
    },
    tool: {
      register: vi.fn(async (spec: { name: string }) => ({
        tool: `mcp__plugin_herdr-subagents__${spec.name}`,
      })),
    },
    ui: { status: vi.fn(), log: vi.fn() },
    prompt: { submit: vi.fn(async (_input: { text: string }) => ({})) },
    clock: { after: vi.fn(() => ({ cancel: () => undefined })) },
  };

  const call = (event: string, e: unknown, next: (e: unknown) => unknown = async () => ({})) =>
    hooks.get(event)!($, e, next);

  return { $, call, hooks };
}

const TOOL = "mcp__plugin_herdr-subagents__subagent";

describe("built Claude plugin", () => {
  it("loads the mod from hooks.json", () => {
    const hooksJson = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks/hooks.json"), "utf8"));
    expect(hooksJson.modules).toEqual(["./register.js"]);
  });

  it("bundles the mod with no imports (no Node, nothing outside the plugin)", () => {
    const bundle = readFileSync(join(PLUGIN_ROOT, "hooks/register.js"), "utf8");
    expect(bundle).not.toMatch(/^\s*import\s/m);
    expect(bundle).not.toMatch(/\brequire\(/);
  });
});

describe("Claude mod: the subagent tool", () => {
  it("registers `subagent` in the prompt's tool list, without wait", async () => {
    const { $, call } = await loadMod();
    await call("session.start", { isInteractive: true });

    const spec = $.tool.register.mock.calls[0]![0] as {
      name: string;
      description: string;
      inputSchema: { properties: { command: { enum: string[] } } };
      isDeferred: boolean;
    };
    expect(spec.name).toBe("subagent");
    expect(spec.isDeferred).toBe(false);
    expect(spec.inputSchema.properties.command.enum).not.toContain("wait");
    expect(spec.inputSchema.properties.command.enum).toContain("spawn");
    expect(spec.description).toContain("`/delegate`");
  });

  it("runs the bundled helper and answers with the descriptive result", async () => {
    const { $, call } = await loadMod({
      run: () => ({ exitCode: 0, stdout: '{"pane_id":"w1","tab_id":"t1"}', stderr: "" }),
    });
    await call("session.start", { isInteractive: true });

    const result = await call("tool.call", {
      tool: TOOL,
      command: "spawn",
      options: { kind: "claude", label: "task" },
    });

    expect($.process.run).toHaveBeenCalledWith(
      [join(PLUGIN_ROOT, "bin/herdr-helper"), "spawn", "--kind", "claude", "--label", "task"],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(result).toEqual({ result: "Started subagent task (pane_id w1, tab_id t1)" });
  });

  it("answers a helper failure as an error result", async () => {
    const { call } = await loadMod({
      run: (argv) =>
        argv[1] === "list"
          ? { exitCode: 0, stdout: '{"children":[]}', stderr: "" }
          : { exitCode: 1, stdout: '{"message":"no such pane"}', stderr: "" },
    });
    await call("session.start", { isInteractive: true });

    const result = await call("tool.call", { tool: TOOL, command: "collect", options: { pane_id: "w9" } });
    expect(result).toEqual({ deny: "Failed to collect subagent subagent: no such pane" });
  });

  it("refuses a call missing a required option without running the helper", async () => {
    const { $, call } = await loadMod();
    await call("session.start", { isInteractive: true });

    const result = await call("tool.call", { tool: TOOL, command: "close", options: {} });
    expect(result).toEqual({ deny: "`tab_id` is required for `close`" });
    expect($.process.run).not.toHaveBeenCalled();
  });

  it("honours the HERDR_SUBAGENT_HELPER override", async () => {
    const { $, call } = await loadMod({
      env: { HERDR_SUBAGENT_HELPER: "/dev/helper" },
      run: () => ({ exitCode: 0, stdout: '{"children":[]}', stderr: "" }),
    });
    await call("session.start", { isInteractive: true });
    await call("tool.call", { tool: TOOL, command: "list" });

    expect($.process.run.mock.calls[0]![0]).toEqual(["/dev/helper", "list"]);
  });

  it("hands HERDR_SUBAGENT_PLUGIN_DIR to Claude children only", async () => {
    const { $, call } = await loadMod({
      env: { HERDR_SUBAGENT_PLUGIN_DIR: "/dev/plugin" },
      run: () => ({ exitCode: 0, stdout: '{"pane_id":"w1","tab_id":"t1"}', stderr: "" }),
    });
    await call("session.start", { isInteractive: true });

    await call("tool.call", { tool: TOOL, command: "spawn", options: { kind: "claude", label: "c" } });
    await call("tool.call", { tool: TOOL, command: "spawn", options: { kind: "pi", label: "p" } });

    expect($.process.run.mock.calls[0]![0]).toEqual(
      expect.arrayContaining(["--plugin-dir", "/dev/plugin"]),
    );
    expect($.process.run.mock.calls[1]![0]).not.toContain("--plugin-dir");
  });

  it("passes other tools' calls through", async () => {
    const { call } = await loadMod();
    await call("session.start", { isInteractive: true });

    const next = vi.fn(async () => ({ result: "from core" }));
    expect(await call("tool.call", { tool: "Bash", command: "ls" }, next)).toEqual({
      result: "from core",
    });
  });
});

describe("Claude mod: the parent role", () => {
  it("watches only in an interactive session inside herdr", async () => {
    const outside = await loadMod();
    await outside.call("session.start", { isInteractive: true });
    expect(outside.$.process.spawn).not.toHaveBeenCalled();

    const headless = await loadMod({ env: { HERDR_PANE_ID: "w1:p1" } });
    await headless.call("session.start", { isInteractive: false });
    expect(headless.$.process.spawn).not.toHaveBeenCalled();

    const inside = await loadMod({ env: { HERDR_PANE_ID: "w1:p1" } });
    await inside.call("session.start", { isInteractive: true });
    expect(inside.$.process.spawn).toHaveBeenCalledWith({
      argv: [join(PLUGIN_ROOT, "bin/herdr-helper"), "watch"],
    });
  });

  it("mirrors watch lines on the status line and wakes on a finished turn", async () => {
    const watch = controlledStream();
    const { $, call } = await loadMod({ env: { HERDR_PANE_ID: "w1:p1" }, watch: () => watch.stream });
    await call("session.start", { isInteractive: true });

    watch.push('{"pane_id":"w1:p2","label":"review","status":"working"}\n{"pane_id":"w1:p2",');
    watch.push('"label":"review","status":"idle"}\n');
    await settle();

    expect($.ui.status).toHaveBeenNthCalledWith(1, "review: working");
    expect($.ui.status).toHaveBeenNthCalledWith(2, "review: idle");
    expect($.prompt.submit).toHaveBeenCalledTimes(1);
    expect($.prompt.submit.mock.calls[0]![0]).toEqual({
      text: expect.stringContaining('Child "review" reached idle'),
    });
  });
});

describe("createWakeQueue", () => {
  it("folds wakes that arrive while a prompt is queued into the next prompt", async () => {
    const releases: Array<() => void> = [];
    const submit = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const wake = createWakeQueue(submit);

    wake("a");
    wake("b");
    wake("c");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenLastCalledWith("a");

    releases[0]!();
    await settle();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenLastCalledWith("b\nc");
  });

  it("keeps delivering after a refused prompt", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("refused")).mockResolvedValue({});
    const wake = createWakeQueue(submit);

    wake("a");
    await settle();
    wake("b");
    await settle();
    expect(submit).toHaveBeenLastCalledWith("b");
  });
});

describe("startParentRole", () => {
  it("clears the status line and restarts a watch that exited", async () => {
    const first = controlledStream();
    const second = controlledStream();
    const streams = [first, second];
    const timers: Array<() => void> = [];
    const host = {
      watch: vi.fn(() => streams.shift()!.stream),
      status: vi.fn(),
      submit: vi.fn(async () => undefined),
      after: vi.fn((_ms: number, fn: () => void) => {
        timers.push(fn);
        return { cancel: () => undefined };
      }),
    };

    startParentRole(host);
    first.push('{"pane_id":"w1:p2","label":"a","status":"working"}\n');
    await settle();
    first.end();
    await settle();

    expect(host.status).toHaveBeenLastCalledWith(undefined);
    expect(host.after).toHaveBeenCalledTimes(1);

    timers[0]!();
    await settle();
    expect(host.watch).toHaveBeenCalledTimes(2);
  });

  it("stops for good: no restart after the stream ends", async () => {
    const stream = controlledStream();
    const host = {
      watch: vi.fn(() => stream.stream),
      status: vi.fn(),
      submit: vi.fn(async () => undefined),
      after: vi.fn(() => ({ cancel: () => undefined })),
    };

    const stop = startParentRole(host);
    stop();
    await settle();

    expect(host.after).not.toHaveBeenCalled();
    expect(host.status).toHaveBeenLastCalledWith(undefined);
  });
});

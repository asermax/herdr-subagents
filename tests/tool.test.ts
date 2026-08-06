import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHelperArgs,
  formatError,
  formatResult,
  runHelper,
  subagentTool,
  type SubagentCommand,
} from "../src/extension/tool.js";

// buildHelperArgs is a pure function — no I/O — so it is tested directly.
// runHelper is tested with stub shell scripts that emit JSON or fail.
// subagentTool.execute is tested end-to-end via a HERDR_SUBAGENT_HELPER stub.

describe("buildHelperArgs", () => {
  it("spawn: kind + label + optional agent", () => {
    expect(buildHelperArgs("spawn", { kind: "pi", label: "review" })).toEqual([
      "spawn",
      "--kind",
      "pi",
      "--label",
      "review",
    ]);
    expect(
      buildHelperArgs("spawn", { kind: "claude", agent: "reviewer", label: "code review" }),
    ).toEqual(["spawn", "--kind", "claude", "--agent", "reviewer", "--label", "code review"]);
  });

  it("prompt: positional pane_id + --body", () => {
    expect(buildHelperArgs("prompt", { pane_id: "w1", body: "do thing" })).toEqual([
      "prompt",
      "w1",
      "--body",
      "do thing",
    ]);
  });

  it("wait: positional pane_id + optional --timeout", () => {
    expect(buildHelperArgs("wait", { pane_id: "w1" })).toEqual(["wait", "w1"]);
    expect(buildHelperArgs("wait", { pane_id: "w1", timeout: 5000 })).toEqual([
      "wait",
      "w1",
      "--timeout",
      "5000",
    ]);
  });

  it("collect: positional pane_id", () => {
    expect(buildHelperArgs("collect", { pane_id: "w1" })).toEqual(["collect", "w1"]);
  });

  it("list: bare subcommand", () => {
    expect(buildHelperArgs("list", {})).toEqual(["list"]);
  });

  it("close: positional tab_id", () => {
    expect(buildHelperArgs("close", { tab_id: "t1" })).toEqual(["close", "t1"]);
  });

  it("omits empty/undefined fields rather than emitting bare flags", () => {
    expect(buildHelperArgs("spawn", {})).toEqual(["spawn"]);
    expect(buildHelperArgs("prompt", {})).toEqual(["prompt"]);
    expect(buildHelperArgs("close", {})).toEqual(["close"]);
  });
});

// --- runHelper with stub scripts ---------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "herdr-tool-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Write an executable stub script at <tmp>/stub that runs `body`. */
function stubHelper(body: string): string {
  const path = join(tmpDir, "stub");
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
  return path;
}

describe("runHelper", () => {
  it("parses JSON stdout on success", async () => {
    const stub = stubHelper(`echo '{"pane_id":"w1","sent":true}'`);
    const out = await runHelper(stub, ["prompt", "w1"], undefined);
    expect(out.exitCode).toBe(0);
    expect(out.json).toEqual({ pane_id: "w1", sent: true });
  });

  it("captures stderr and exit code on failure", async () => {
    const stub = stubHelper(`echo 'bad thing' >&2; exit 1`);
    const out = await runHelper(stub, ["spawn"], undefined);
    expect(out.exitCode).toBe(1);
    expect(out.json).toBeUndefined();
    expect(out.stderr).toContain("bad thing");
  });

  it("parses error JSON emitted before a non-zero exit", async () => {
    const stub = stubHelper(`echo '{"reason":"timeout","message":"nope"}'; exit 1`);
    const out = await runHelper(stub, ["spawn"], undefined);
    expect(out.exitCode).toBe(1);
    expect(out.json).toEqual({ reason: "timeout", message: "nope" });
  });

  it("returns exitCode 1 and stderr when the binary does not exist", async () => {
    const out = await runHelper(join(tmpDir, "nope"), ["list"], undefined);
    expect(out.exitCode).toBe(1);
    expect(out.stderr.length).toBeGreaterThan(0);
  });
});

// --- formatResult -------------------------------------------------------

describe("formatResult", () => {
  it("spawn: names the subagent without pane/tab", () => {
    const text = formatResult("spawn", { label: "review" }, { pane_id: "w1:p2", tab_id: "w1:t2" });
    expect(text).toBe("Started subagent review");
  });

  it("prompt: uses the label and strips the supervisor-agent tag", () => {
    const text = formatResult("prompt", { pane_id: "w1", label: "review", body: "<supervisor-agent>do thing</supervisor-agent>" }, { pane_id: "w1", sent: true });
    expect(text).toBe("Sent prompt to subagent review:\ndo thing");
  });

  it("wait: names the subagent", () => {
    const text = formatResult("wait", { pane_id: "w1", label: "review" }, { pane_id: "w1", status: "done" });
    expect(text).toBe("Waited for subagent review");
  });

  it("collect: message", () => {
    const text = formatResult("collect", { pane_id: "w1" }, { pane_id: "w1", label: "rev", agent: "rev", status: "done", message: "all good" });
    expect(text).toBe("Subagent rev:\nall good");
  });

  it("collect: asking a question", () => {
    const text = formatResult("collect", { pane_id: "w1" }, { pane_id: "w1", label: "rev", agent: "rev", status: "done", message: "which file?", ask: true });
    expect(text).toBe("Subagent rev is asking:\nwhich file?");
  });

  it("collect: errored", () => {
    const text = formatResult("collect", { pane_id: "w1" }, { pane_id: "w1", label: "rev", agent: "rev", status: "gone", error: "lost pane" });
    expect(text).toBe("Subagent rev errored: lost pane");
  });

  it("collect: no message", () => {
    const text = formatResult("collect", { pane_id: "w1" }, { pane_id: "w1", label: "rev", agent: "rev", status: "blocked" });
    expect(text).toBe("Subagent rev has no message yet");
  });

  it("list: empty fleet", () => {
    expect(formatResult("list", {}, { children: [] })).toBe("No children tracked.");
  });

  it("list: non-empty fleet shows labels only", () => {
    const text = formatResult("list", {}, {
      children: [
        { pane_id: "w1:p2", label: "review", status: "done" },
        { pane_id: "w1:p3", label: "tests", status: "working" },
      ],
    });
    expect(text).toBe("Fleet (2):\n  review\n  tests");
  });

  it("close: uses the label", () => {
    expect(formatResult("close", { tab_id: "t1", label: "review" }, { tab_id: "t1", closed: true })).toBe(
      "Closed subagent review",
    );
  });
});

// --- formatError --------------------------------------------------------

describe("formatError", () => {
  it("extracts the message from helper error JSON", () => {
    const msg = formatError("spawn", { label: "x" }, { reason: "timeout", message: "never ready" }, "");
    expect(msg).toBe("Failed to spawn subagent x: never ready");
  });

  it("falls back to stderr when no JSON is present", () => {
    const msg = formatError("prompt", { pane_id: "w1", label: "review" }, undefined, "--body is required");
    expect(msg).toBe("Failed to prompt subagent review: --body is required");
  });

  it("falls back to a generic message when neither JSON nor stderr has detail", () => {
    const msg = formatError("list", {}, undefined, "");
    expect(msg).toContain("Failed to list");
  });
});

// --- subagentTool.execute end-to-end -----------------------------------

describe("subagentTool.execute", () => {
  const savedHelper = process.env.HERDR_SUBAGENT_HELPER;

  afterEach(() => {
    if (savedHelper === undefined) delete process.env.HERDR_SUBAGENT_HELPER;
    else process.env.HERDR_SUBAGENT_HELPER = savedHelper;
  });

  function pointAtStub(body: string): void {
    process.env.HERDR_SUBAGENT_HELPER = stubHelper(body);
  }

  it("returns a descriptive summary on spawn success", async () => {
    pointAtStub(`echo '{"pane_id":"w1","tab_id":"t1"}'`);
    const result = await subagentTool.execute(
      "call-1",
      { command: "spawn", options: { kind: "pi", label: "task" } },
      undefined,
      undefined,
      {} as never,
    );
    expect(result.details).toEqual({ command: "spawn", exitCode: 0 });
    expect((result.content[0] as { text: string }).text).toBe("Started subagent task");
  });

  it("throws a descriptive error on helper failure", async () => {
    pointAtStub(`echo '--kind is required' >&2; exit 2`);
    await expect(
      subagentTool.execute(
        "call-1",
        { command: "spawn", options: {} },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Failed to spawn");
  });

  it("throws a descriptive error when the helper emits error JSON", async () => {
    pointAtStub(`echo '{"reason":"timeout","message":"never ready"}'; exit 1`);
    await expect(
      subagentTool.execute(
        "call-1",
        { command: "spawn", options: { kind: "pi", label: "x" } },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow('Failed to spawn subagent x');
  });

  it("list returns a descriptive message when empty", async () => {
    pointAtStub(`echo '{"children":[]}'`);
    const result = await subagentTool.execute(
      "call-1",
      { command: "list", options: {} },
      undefined,
      undefined,
      {} as never,
    );
    expect((result.content[0] as { text: string }).text).toBe("No children tracked.");
  });
});

// --- tool definition metadata ------------------------------------------

describe("subagentTool definition", () => {
  it("is named 'subagent'", () => {
    expect(subagentTool.name).toBe("subagent");
  });

  it("has a label, description, and prompt snippet", () => {
    expect(subagentTool.label.length).toBeGreaterThan(0);
    expect(subagentTool.description.length).toBeGreaterThan(0);
    expect(subagentTool.promptSnippet!.length).toBeGreaterThan(0);
  });

  it("has prompt guidelines covering the workflow", () => {
    expect(subagentTool.promptGuidelines!.length).toBeGreaterThanOrEqual(5);
    const joined = subagentTool.promptGuidelines!.join("\n");
    for (const cmd of ["spawn", "prompt", "collect", "close", "list"] as SubagentCommand[]) {
      expect(joined).toContain(cmd);
    }
  });

  it("exposes a command enum with all six commands", () => {
    const props = subagentTool.parameters as unknown as {
      properties: { command: { anyOf: Array<{ const: string }> } };
    };
    const commands = props.properties.command.anyOf.map((c) => c.const);
    expect(commands).toEqual(
      expect.arrayContaining(["spawn", "prompt", "wait", "collect", "list", "close"]),
    );
  });
});

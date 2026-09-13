import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubHerdrServer, type ScriptedEvent } from "./stub-server.js";

// Black-box CLI process tests. These spawn the compiled helper entrypoint and
// assert on stdout/exit code — the highest seam. They cover the boundary guards
// the in-process tests cannot: --kind rejection happens before any herdr call.

const BUILT = buildCliOnce();

function buildCliOnce(): string {
  const outDir = mkdtempSync(join(tmpdir(), "herdr-cli-build-"));
  try {
    buildSync({
      entryPoints: [join(process.cwd(), "src/helper/cli.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: join(outDir, "cli.mjs"),
    });
  } catch (e) {
    rmSync(outDir, { recursive: true, force: true });
    throw e;
  }
  return join(outDir, "cli.mjs");
}

afterAll(() => {
  rmSync(join(BUILT, ".."), { recursive: true, force: true });
});

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  return new Promise((resolve) => {
    const child = spawn("node", [BUILT, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

describe("CLI --kind rejection", () => {
  it("rejects a kind outside pi|claude before reaching herdr", async () => {
    // No HERDR_SOCKET_PATH set: if the helper reached herdr at all it would
    // fail on the socket path. Rejection must happen first, with exit 2.
    const { code, stderr } = await runCli([
      "spawn",
      "--kind",
      "codex",
      "--agent",
      "doer",
      "--label",
      "x",
      "--body",
      "x",
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--kind must be one of pi\|claude/);
  });

  it("requires --kind", async () => {
    const { code, stderr } = await runCli([
      "spawn",
      "--agent",
      "doer",
      "--label",
      "x",
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--kind is required/);
  });

  it("rejects a path as --agent", async () => {
    const { code, stderr } = await runCli([
      "spawn",
      "--kind",
      "pi",
      "--agent",
      "./agents/doer.md",
      "--label",
      "x",
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--agent must be a name, not a path/);
  });

  it("rejects --branch without --worktree rather than ignoring it", async () => {
    const { code, stderr } = await runCli([
      "spawn",
      "--kind",
      "pi",
      "--label",
      "x",
      "--branch",
      "feat/login",
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--branch and --base require --worktree/);
  });

  it("rejects an unknown subcommand", async () => {
    const { code, stderr } = await runCli(["bogus"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/unknown subcommand/);
  });
});

describe("CLI value-bearing --label", () => {
  it("accepts a --label value that starts with -- (parse passes validation)", async () => {
    // The old parser let a value-bearing flag take a value that starts with
    // --. citty must too: if it dropped the value, --label would read as
    // missing and fail with exit 2 "--label is required". Instead the parse
    // succeeds and the command reaches the socket check (exit 1).
    //
    // spawn reads HERDR_WORKSPACE_ID before the socket check, so set a dummy
    // value: without it a clean env (CI) fails on the workspace check instead
    // of the socket check the assertion expects. Locally the shell inherits
    // it, which hid the dependency.
    const { code, stderr } = await runCli(
      ["spawn", "--kind", "pi", "--agent", "doer", "--label", "--refactor", "--body", "x"],
      { HERDR_SOCKET_PATH: "", HERDR_WORKSPACE_ID: "test-ws" },
    );
    expect(code).toBe(1);
    expect(stderr).not.toMatch(/--label is required/);
    expect(stderr).toMatch(/HERDR_SOCKET_PATH/);
  });
});

describe("CLI unblock key validation", () => {
  it("requires --keys", async () => {
    const { code, stderr } = await runCli(["unblock", "w1Z:p1"], { HERDR_SOCKET_PATH: "" });
    expect(code).toBe(2);
    expect(stderr).toMatch(/--keys is required/);
  });

  it("passes key names through to herdr, which is the authority on the set", async () => {
    const { code, stderr } = await runCli(["unblock", "w1Z:p1", "--keys", "1 enter"], {
      HERDR_SOCKET_PATH: "",
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/HERDR_SOCKET_PATH/);
  });
});

describe("CLI help surface", () => {
  it("lists every subcommand in the usage error", async () => {
    const { stderr } = await runCli([]);
    expect(stderr).toMatch(/spawn/);
    expect(stderr).toMatch(/prompt/);
    expect(stderr).toMatch(/wait/);
    expect(stderr).toMatch(/collect/);
    expect(stderr).toMatch(/list/);
    expect(stderr).toMatch(/close/);
    expect(stderr).toMatch(/read/);
    expect(stderr).toMatch(/unblock/);
    expect(stderr).toMatch(/watch/);
  });
});

// --- spawn --body: the initial prompt rides the spawn --------------------
//
// The helper shells out to HERDR_BIN for every CLI operation, so a stub
// binary answering with herdr's JSON-RPC envelope drives the whole sequence:
// tab create, agent start, agent get, agent prompt. A state file scripts it —
// what agent.get reports, whether agent prompt refuses, where delivered
// bodies are logged. Delivery verification stays on the socket, served by
// StubHerdrServer, so the full spawn→deliver→ack path runs end to end.
describe("CLI spawn/prompt --body", () => {
  let server: StubHerdrServer;
  let tmpDir: string;
  let stubEnv: NodeJS.ProcessEnv;

  function writeState(state: Record<string, unknown>): void {
    writeFileSync(join(tmpDir, "state.json"), JSON.stringify(state));
  }

  function readRegistry(): Record<string, { acked_seq?: number; acked_status?: string }> {
    return JSON.parse(readFileSync(join(tmpDir, "registry.json"), "utf8"));
  }

  function readEntry(): { acked_seq?: number; acked_status?: string } {
    const entry = readRegistry()["wS:p1"];
    if (entry === undefined) throw new Error("no registry entry for wS:p1");
    return entry;
  }

  function writeHerdrStub(): string {
    const bin = join(tmpDir, "herdr-stub.mjs");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env node",
        "import { appendFileSync, readFileSync } from 'node:fs';",
        "const [cmd, sub, target, body] = process.argv.slice(2);",
        "const state = JSON.parse(readFileSync(process.env.STUB_STATE, 'utf8'));",
        "const ok = (result) => { console.log(JSON.stringify({ id: 1, result })); process.exit(0); };",
        "if (cmd === 'tab' && sub === 'create') ok({ root_pane: { pane_id: 'wS:p1', tab_id: 'wS:t1', workspace_id: 'wS' } });",
        "if (cmd === 'agent' && sub === 'start') ok({ agent: { pane_id: 'wS:p1', tab_id: 'wS:t1', workspace_id: 'wS', name: target, agent: 'pi', agent_status: 'idle', state_change_seq: 5 } });",
        "if (cmd === 'agent' && sub === 'get') ok({ agent: { pane_id: 'wS:p1', tab_id: 'wS:t1', workspace_id: 'wS', name: 'doer', agent: 'pi', agent_status: state.getStatus, state_change_seq: state.seq } });",
        "if (cmd === 'agent' && sub === 'prompt') {",
        "  if (state.promptFails) { process.stderr.write(JSON.stringify({ id: 1, error: { code: 'prompt_failed', message: 'herdr refused' } })); process.exit(1); }",
        "  appendFileSync(state.log, body + '\\n');",
        "}",
        "ok({});",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  beforeEach(async () => {
    server = new StubHerdrServer();
    await server.start();
    tmpDir = mkdtempSync(join(tmpdir(), "herdr-spawn-body-"));
    const logPath = join(tmpDir, "prompts.log");
    writeState({ getStatus: "working", seq: 6, promptFails: false, log: logPath });
    stubEnv = {
      HERDR_BIN: writeHerdrStub(),
      HERDR_SOCKET_PATH: server.socketPath,
      HERDR_WORKSPACE_ID: "wS",
      HERDR_REGISTRY_PATH: join(tmpDir, "registry.json"),
      STUB_STATE: join(tmpDir, "state.json"),
    };
  });

  afterEach(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("delivers the initial prompt with the spawn and acks it", async () => {
    // The delivery event must be newer than the agent.get seq (6) so the
    // client's stale filter does not drop it.
    server.script([{ paneId: "wS:p1", status: "working", seq: 7 } as ScriptedEvent]);
    const { code, stdout, stderr } = await runCli(
      [
        "spawn",
        "--kind",
        "pi",
        "--agent",
        "doer",
        "--label",
        "x",
        "--body",
        "<supervisor-agent>do it</supervisor-agent>",
      ],
      stubEnv,
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout.trim());
    expect(result.pane_id).toBe("wS:p1");
    expect(result.tab_id).toBe("wS:t1");
    expect(result.prompt).toEqual({ sent: true, status: "working" });
    expect(readFileSync(join(tmpDir, "prompts.log"), "utf8")).toBe(
      "<supervisor-agent>do it</supervisor-agent>\n",
    );
    const entry = readEntry();
    expect(entry.acked_seq).toBe(6);
    expect(entry.acked_status).toBe("working");
  });

  it("delivers the initial prompt from --body-file", async () => {
    server.script([{ paneId: "wS:p1", status: "working", seq: 7 } as ScriptedEvent]);
    const bodyFile = join(tmpDir, "task.md");
    writeFileSync(bodyFile, "<supervisor-agent>do it from a file</supervisor-agent>");
    const { code, stdout, stderr } = await runCli(
      ["spawn", "--kind", "pi", "--agent", "doer", "--label", "x", "--body-file", bodyFile],
      stubEnv,
    );
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const result = JSON.parse(stdout.trim());
    expect(result.prompt).toEqual({ sent: true, status: "working" });
    expect(readFileSync(join(tmpDir, "prompts.log"), "utf8")).toBe(
      "<supervisor-agent>do it from a file</supervisor-agent>\n",
    );
  });

  it("resolves a relative --body-file against the helper's cwd", async () => {
    server.script([{ paneId: "wS:p1", status: "working", seq: 7 } as ScriptedEvent]);
    writeFileSync(join(tmpDir, "task.md"), "<supervisor-agent>relative</supervisor-agent>");
    const cwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const { code, stdout } = await runCli(
        ["spawn", "--kind", "pi", "--agent", "doer", "--label", "x", "--body-file", "task.md"],
        stubEnv,
      );
      expect(code).toBe(0);
      expect(JSON.parse(stdout.trim()).prompt).toEqual({ sent: true, status: "working" });
      expect(readFileSync(join(tmpDir, "prompts.log"), "utf8")).toBe(
        "<supervisor-agent>relative</supervisor-agent>\n",
      );
    } finally {
      process.chdir(cwd);
    }
  });

  it("prompt delivers a --body-file body", async () => {
    server.script([{ paneId: "wS:p1", status: "working", seq: 7 } as ScriptedEvent]);
    const bodyFile = join(tmpDir, "reply.md");
    writeFileSync(bodyFile, "<supervisor-agent>and now this</supervisor-agent>");
    const { code, stdout } = await runCli(["prompt", "wS:p1", "--body-file", bodyFile], stubEnv);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ pane_id: "wS:p1", sent: true, status: "working" });
    expect(readFileSync(join(tmpDir, "prompts.log"), "utf8")).toBe(
      "<supervisor-agent>and now this</supervisor-agent>\n",
    );
  });

  it("spawn without --body emits the plain spawn result", async () => {
    const { code, stdout } = await runCli(
      ["spawn", "--kind", "pi", "--agent", "doer", "--label", "x"],
      stubEnv,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ pane_id: "wS:p1", tab_id: "wS:t1" });
    // No prompt delivered, so nothing was acked.
    expect(readEntry().acked_seq).toBeUndefined();
  });

  it("a delivery failure keeps the live child and names the pane to retry", async () => {
    writeState({ getStatus: "working", seq: 6, promptFails: true, log: join(tmpDir, "prompts.log") });
    const { code, stdout, stderr } = await runCli(
      [
        "spawn",
        "--kind",
        "pi",
        "--agent",
        "doer",
        "--label",
        "x",
        "--body",
        "<supervisor-agent>do it</supervisor-agent>",
      ],
      stubEnv,
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/alive but the prompt was not delivered/);
    expect(stderr).toMatch(/helper prompt wS:p1 --body/);
    expect(JSON.parse(stdout.trim())).toMatchObject({ reason: "delivery" });
    // The child is live and stays tracked, unacked.
    const entry = readEntry();
    expect(entry).toBeTruthy();
    expect(entry.acked_seq).toBeUndefined();
  });
});

describe("CLI --body-file validation", () => {
  it("rejects --body together with --body-file (spawn)", async () => {
    const { code, stderr } = await runCli([
      "spawn",
      "--kind",
      "pi",
      "--label",
      "x",
      "--body",
      "a",
      "--body-file",
      "b",
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/mutually exclusive/);
  });

  it("rejects --body together with --body-file (prompt)", async () => {
    const { code, stderr } = await runCli(["prompt", "w1Z:p1", "--body", "a", "--body-file", "b"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/mutually exclusive/);
  });

  it("rejects an unreadable --body-file before creating the child", async () => {
    const { code, stderr } = await runCli([
      "spawn",
      "--kind",
      "pi",
      "--label",
      "x",
      "--body-file",
      "/nonexistent/task.md",
    ]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/cannot read --body-file/);
  });

  it("requires one of --body/--body-file on prompt", async () => {
    const { code, stderr } = await runCli(["prompt", "w1Z:p1"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--body or --body-file is required/);
  });
});

// collect/close/wait/prompt recover their positional id (pane or tab) from
// argv directly. A double-slice once ate the id, so each printed its usage
// line and exited 2. With the id present the command must get PAST the usage
// guard; with no HERDR_SOCKET_PATH it then fails at the socket check (exit 1,
// no "usage") — the signal the id was extracted.
describe("CLI positional id extraction", () => {
  it("collect extracts the pane_id", async () => {
    const { code, stderr } = await runCli(["collect", "w1Z:p1"], { HERDR_SOCKET_PATH: "" });
    expect(code).toBe(1);
    expect(stderr).not.toMatch(/usage/);
    expect(stderr).toMatch(/HERDR_SOCKET_PATH/);
  });

  it("close extracts the tab_id", async () => {
    const { code, stderr } = await runCli(["close", "w1Z:t1"], { HERDR_SOCKET_PATH: "" });
    expect(code).toBe(1);
    expect(stderr).not.toMatch(/usage/);
    expect(stderr).toMatch(/HERDR_SOCKET_PATH/);
  });

  it("wait extracts the pane_id", async () => {
    const { code, stderr } = await runCli(["wait", "w1Z:p1"], { HERDR_SOCKET_PATH: "" });
    expect(code).toBe(1);
    expect(stderr).not.toMatch(/usage/);
    expect(stderr).toMatch(/HERDR_SOCKET_PATH/);
  });

  it("read extracts the pane_id", async () => {
    const { code, stderr } = await runCli(["read", "w1Z:p1"], { HERDR_SOCKET_PATH: "" });
    expect(code).toBe(1);
    expect(stderr).not.toMatch(/usage/);
    expect(stderr).toMatch(/HERDR_SOCKET_PATH/);
  });

  it("prompt extracts the pane_id (with --body)", async () => {
    const { code, stderr } = await runCli(
      ["prompt", "w1Z:p1", "--body", "<supervisor-agent>do it</supervisor-agent>"],
      { HERDR_SOCKET_PATH: "" },
    );
    expect(code).toBe(1);
    expect(stderr).not.toMatch(/usage/);
    expect(stderr).toMatch(/HERDR_SOCKET_PATH/);
  });
});

import { afterAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    const { code, stderr } = await runCli(
      ["spawn", "--kind", "pi", "--agent", "doer", "--label", "--refactor", "--body", "x"],
      { HERDR_SOCKET_PATH: "" },
    );
    expect(code).toBe(1);
    expect(stderr).not.toMatch(/--label is required/);
    expect(stderr).toMatch(/HERDR_SOCKET_PATH/);
  });
});

describe("CLI help surface", () => {
  it("lists the six subcommands in the usage error", async () => {
    const { stderr } = await runCli([]);
    expect(stderr).toMatch(/spawn/);
    expect(stderr).toMatch(/prompt/);
    expect(stderr).toMatch(/wait/);
    expect(stderr).toMatch(/collect/);
    expect(stderr).toMatch(/list/);
    expect(stderr).toMatch(/close/);
    expect(stderr).toMatch(/watch/);
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

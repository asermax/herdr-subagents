import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitArtifact } from "../build/emit.ts";
import { HELPER_BIN } from "../build/harness.ts";

// Seam 1: the onboarding hook is a process whose stdout and exit
// code are observable. Built into a real plugin tree and driven as a subprocess
// — the same shape as tests/cli.test.ts. No live e2e, no build-output diff, no
// skill-prose test.

const PLUGIN_ROOT = buildPluginOnce();

function buildPluginOnce(): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-claude-hook-"));
  emitArtifact("claude", root);
  return root;
}

afterAll(() => {
  rmSync(PLUGIN_ROOT, { recursive: true, force: true });
});

function runHook(env: NodeJS.ProcessEnv): Promise<{
  stdout: string;
  stderr: string;
  code: number;
}> {
  return new Promise((resolve) => {
    const child = spawn("bash", [join(PLUGIN_ROOT, "hooks/onboarding.sh")], {
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

describe("SessionStart onboarding hook — the gate (Seam 1)", () => {
  it("writes onboarding to stdout when HERDR_SUBAGENT is set", async () => {
    const { stdout, code } = await runHook({ HERDR_SUBAGENT: "1" });
    expect(code).toBe(0);

    // The four onboarding topics, and nothing else, ride stdout.
    // 1. Identity: a parent spawned this session; a human can step in.
    expect(stdout).toMatch(/spawned as a subagent by a parent agent/);
    expect(stdout).toMatch(/human can also see your work/);
    // 2. Asking the parent: end the turn wrapped in <subagent-ask>.
    expect(stdout).toMatch(/<subagent-ask>/);
    // 3. Tagged prompts: <supervisor-agent> vs an untagged human message.
    expect(stdout).toMatch(/<supervisor-agent>/);
    // 4. The child may delegate.
    expect(stdout).toMatch(/spawn your own children/);
  });

  it("exits silently and successfully when the gate is absent", async () => {
    // Gate unset entirely.
    const unset = await runHook({ HERDR_SUBAGENT: undefined });
    expect(unset.code).toBe(0);
    expect(unset.stdout).toBe("");
    expect(unset.stderr).toBe("");

    // Gate present but empty — still "absent" (treated as a normal session).
    const empty = await runHook({ HERDR_SUBAGENT: "" });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toBe("");
    expect(empty.stderr).toBe("");
  });
});

describe("SessionStart hook wiring (Seam 1)", () => {
  const hooksJson = JSON.parse(
    readFileSync(join(PLUGIN_ROOT, "hooks/hooks.json"), "utf8"),
  ) as {
    hooks: {
      SessionStart: Array<{
        matcher: string;
        hooks: Array<{ type: string; command: string; args?: string[] }>;
      }>;
    };
  };

  it("covers startup, resume, clear, and compact (survives compression)", () => {
    const matcher = hooksJson.hooks.SessionStart[0]!.matcher;
    for (const reason of ["startup", "resume", "clear", "compact"]) {
      expect(matcher).toContain(reason);
    }
  });

  it("is wired in exec form so paths survive the plugin cache copy", () => {
    const hook = hooksJson.hooks.SessionStart[0]!.hooks[0]!;
    // Exec form: command is the executable, args carry the script path. The
    // script path uses ${CLAUDE_PLUGIN_ROOT} (not a hardcoded absolute path),
    // which is what survives the cache copy without quoting.
    expect(hook.type).toBe("command");
    expect(hook.command).toBe("bash");
    expect(hook.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/hooks/onboarding.sh",
    ]);
  });
});

describe("generated claude delegate skill (Seam 1)", () => {
  it("carries the absolute helper path (from the build token) and the claude wake fragment", () => {
    const skillPath = join(PLUGIN_ROOT, "skills/delegate/SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const body = readFileSync(skillPath, "utf8");

    // The claude wake: model-armed background wait after every prompt.
    expect(body).toContain("arm the wake");
    expect(body).toContain(`${PLUGIN_ROOT}/${HELPER_BIN}`);
    // No placeholder survives the build.
    expect(body).not.toMatch(/\{\{wake\}\}/);
    expect(body).not.toMatch(/\{\{helper\}\}/);
  });

  it("names the skill /delegate via frontmatter", () => {
    const body = readFileSync(join(PLUGIN_ROOT, "skills/delegate/SKILL.md"), "utf8");
    expect(body).toMatch(/^---\nname: delegate\n/m);
  });
});

// The onboarding content the hook emits is the shared static source — the same
// file both injection paths read. This guards that the hook reads the shipped
// copy, not a stale path, without asserting on skill prose.
describe("hook emits the shipped onboarding", () => {
  it("stdout equals references/onboarding.md when the gate is set", async () => {
    const { stdout } = await runHook({ HERDR_SUBAGENT: "1" });
    const shipped = readFileSync(join(PLUGIN_ROOT, "references/onboarding.md"), "utf8");
    expect(stdout).toBe(shipped);
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitArtifact } from "../build/emit.ts";
import { tokenMapFor, HELPER_BIN } from "../build/harness.ts";
import { coverageSources } from "../build/plan.ts";
import { assertCoverage } from "../build/coverage.ts";

/**
 * Not a build-output diff test. This asserts the token contract holds end to
 * end: every token is declared and consumed (coverage), and emit succeeds
 * with every placeholder resolved.
 */
describe("build, all tokens", () => {
  it("declares and consumes the per-harness token set", () => {
    for (const harness of ["pi", "claude"] as const) {
      const sources = coverageSources(harness);
      const map = tokenMapFor(harness);
      // Throws TokenNotConsumedError / UncoveredPlaceholderError on mismatch.
      expect(() => assertCoverage(sources, map)).not.toThrow();
      expect(Object.keys(map)).toEqual(["invoke"]);
    }
  });

  it("emits both artifacts with the invoke fragment injected and no helper named", () => {
    // The delegate body lives at the path each harness discovers: pi reads the
    // package `skills/` dir (flat file); claude auto-discovers `skills/<name>/SKILL.md`.
    const delegatePath: Record<"pi" | "claude", string> = {
      pi: "skills/delegate.md",
      claude: "skills/delegate/SKILL.md",
    };

    for (const harness of ["pi", "claude"] as const) {
      const root = mkdtempSync(join(tmpdir(), "herdr-build-"));
      try {
        // The both-directions coverage assertion runs inside emit; a mismatch
        // throws before any file is written.
        expect(() => emitArtifact(harness, root)).not.toThrow();

        const bodyPath = join(root, delegatePath[harness]);
        expect(existsSync(bodyPath)).toBe(true);
        const body = readFileSync(bodyPath, "utf8");

        // Both harnesses wake the parent themselves.
        expect(body).toContain("wakes you automatically");
        // The skill never names the helper — no env var, no binary — the
        // `subagent` tool is the model's only interface on both harnesses.
        expect(body).not.toContain("HERDR_SUBAGENT_HELPER");
        expect(body).not.toContain(HELPER_BIN);
        // No placeholder survives anywhere in the emitted artifact.
        expect(body).not.toMatch(/\{\{\w+\}\}/);
        // The invoke fragment was injected at {{invoke}}.
        expect(body).toContain("`subagent` tool");
        // `wait` is pi's alone: the Claude mod has no blocking wait.
        if (harness === "pi") expect(body).toContain("| wait ");
        else expect(body).not.toContain("| wait ");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

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
 * end: all three tokens are declared and consumed (coverage), and emit succeeds
 * with every placeholder resolved.
 */
describe("build, all tokens", () => {
  it("declares and consumes the per-harness token set", () => {
    const expectedKeys: Record<"pi" | "claude", string[]> = {
      // The pi skill never names the helper — the `subagent` tool is the
      // model's only interface there — so the pi map omits the token.
      pi: ["invoke", "wake"],
      claude: ["helper", "invoke", "wake"],
    };
    for (const harness of ["pi", "claude"] as const) {
      const sources = coverageSources(harness);
      const map = tokenMapFor(harness);
      // Throws TokenNotConsumedError / UncoveredPlaceholderError on mismatch.
      expect(() => assertCoverage(sources, map)).not.toThrow();
      expect(Object.keys(map).sort()).toEqual(expectedKeys[harness]);
    }
  });

  it("emits both artifacts with the wake fragment injected and {{helper}} resolved", () => {
    const wakeMarker: Record<"pi" | "claude", string> = {
      pi: "wakes you automatically",
      claude: "arm the wake",
    };
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

        // The wake fragment was injected at {{wake}}.
        expect(body).toContain(wakeMarker[harness]);
        // The helper path resolves at RUNTIME so a skill built anywhere (CI
        // included) works on any install: claude expands $CLAUDE_PLUGIN_ROOT.
        // pi's skill must not name the helper at all — no env var, no binary —
        // the `subagent` tool is the model's only interface there.
        if (harness === "claude") {
          expect(body).toContain("${CLAUDE_PLUGIN_ROOT}/bin/" + HELPER_BIN);
        } else {
          expect(body).not.toContain("HERDR_SUBAGENT_HELPER");
          expect(body).not.toContain(HELPER_BIN);
        }
        // No placeholder survives anywhere in the emitted artifact.
        expect(body).not.toMatch(/\{\{wake\}\}/);
        expect(body).not.toMatch(/\{\{helper\}\}/);
        expect(body).not.toMatch(/\{\{invoke\}\}/);
        // The invoke fragment was injected at {{invoke}}.
        const invokeMarker: Record<"pi" | "claude", string> = {
          pi: "`subagent` tool",
          claude: "CLI invoked over bash",
        };
        expect(body).toContain(invokeMarker[harness]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

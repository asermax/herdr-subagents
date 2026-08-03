import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitArtifact } from "../build/emit.ts";
import { tokenMapFor } from "../build/harness.ts";
import { coverageSources } from "../build/plan.ts";
import { assertCoverage } from "../build/coverage.ts";
import { substitute, TokenNotConvergedError } from "../build/substitute.ts";

/**
 * Not a build-output diff test (forbidden by spec Testing "Not tested"). This
 * asserts the token contract holds end to end: both tokens are declared and
 * consumed (coverage), and the convergence guard catches the one real defect.
 */
describe("build, both tokens", () => {
  it("declares and consumes both {{wake}} and {{helper}} for each harness", () => {
    for (const harness of ["pi", "claude"] as const) {
      const sources = coverageSources(harness);
      const map = tokenMapFor(harness, "/tmp/fake-root");
      // Throws TokenNotConsumedError / UncoveredPlaceholderError on mismatch.
      expect(() => assertCoverage(sources, map)).not.toThrow();
      expect(Object.keys(map).sort()).toEqual(["helper", "wake"]);
    }
  });

  it("refuses to emit while a wake fragment embeds {{wake}} as prose (guard)", () => {
    // The drafted wake fragments still carry a `<!-- Injects into {{wake}} -->`
    // metadata line as prose. That makes {{wake}}'s value self-referential, so
    // substitution never converges and emit must refuse rather than ship a
    // broken artifact. Tracked on #18; flipping this assertion is the signal.
    for (const harness of ["pi", "claude"] as const) {
      const root = mkdtempSync(join(tmpdir(), "herdr-build-"));
      try {
        expect(() => emitArtifact(harness, root)).toThrow(TokenNotConvergedError);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("resolves every placeholder once source is clean (post-#18 path)", () => {
    // The wake fragment references {{helper}}; the fixpoint resolves both tokens
    // in one substitute call. This is the path emitArtifact takes once #18
    // drops the stray {{wake}} metadata line from the fragment files.
    const out = substitute("arm {{wake}}", {
      wake: "it spawns {{helper}} watch",
      helper: "/bin/herdr-helper",
    });
    expect(out).not.toMatch(/\{\{wake\}\}/);
    expect(out).not.toMatch(/\{\{helper\}\}/);
  });
});

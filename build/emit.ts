import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Harness } from "./harness.ts";
import { tokenMapFor } from "./harness.ts";
import { filePlan, coverageSources } from "./plan.ts";
import { substitute } from "./substitute.ts";
import { assertCoverage } from "./coverage.ts";
import { srcDir } from "./paths.ts";
import { readFileSync } from "node:fs";

/** Emit one complete artifact for `harness` rooted at `artifactRoot`. */
export function emitArtifact(harness: Harness, artifactRoot: string): void {
  const map = tokenMapFor(harness, artifactRoot);
  const sources = coverageSources(harness);

  // Drift is prevented by construction (spec §9): assert coverage both ways
  // before writing anything, so a mismatched map never reaches the output.
  assertCoverage(sources, map);

  rmSync(artifactRoot, { recursive: true, force: true });
  mkdirSync(artifactRoot, { recursive: true });

  for (const file of filePlan(harness)) {
    const dest = join(artifactRoot, file.dest);
    mkdirSync(join(dest, ".."), { recursive: true });

    let content: string;
    if (file.type === "substitute") {
      content = substitute(readFileSync(join(srcDir, file.src), "utf8"), map);
    } else if (file.type === "copy") {
      content = readFileSync(join(srcDir, file.src), "utf8");
    } else {
      content = file.render(map);
    }

    writeFileSync(dest, content);
  }
}

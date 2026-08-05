import { join } from "node:path";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { buildSync } from "esbuild";
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

  // Drift is prevented by construction: assert coverage both ways before
  // writing anything, so a mismatched map never reaches the output.
  assertCoverage(sources, map);

  rmSync(artifactRoot, { recursive: true, force: true });
  mkdirSync(artifactRoot, { recursive: true });

  for (const file of filePlan(harness)) {
    const dest = join(artifactRoot, file.dest);
    mkdirSync(join(dest, ".."), { recursive: true });

    if (file.type === "bundle") {
      // Bundle the entry into a single self-contained ESM file with a node
      // shebang, then mark it executable so it can be spawned by path.
      const bundled = bundleHelper(join(srcDir, file.src));
      writeFileSync(dest, bundled);
      chmodSync(dest, 0o755);
      continue;
    }

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

// Bundle the helper into one ESM file with a node shebang. esbuild inlines the
// helper's siblings (collect, registry, herdr-client, …) so the result is a
// single spawnable binary with no further resolution at runtime.
function bundleHelper(entry: string): string {
  const out = buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  const code = out.outputFiles[0]?.text ?? "";
  // esbuild preserves a shebang from the source entry; drop it so we add
  // exactly one.
  const stripped = code.startsWith("#!") ? code.slice(code.indexOf("\n") + 1) : code;
  return "#!/usr/bin/env node\n" + stripped;
}

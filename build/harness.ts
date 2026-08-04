import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { TokenMap } from "./tokens.ts";
import { srcDir } from "./paths.ts";

export type Harness = "pi" | "claude";

/** Names of the two shipped artifacts (spec §9). */
export const PI_PACKAGE_NAME = "pi-herdr-subagents";
export const PI_PACKAGE_SCOPE = "@asermax/pi-herdr-subagents";
export const CLAUDE_PLUGIN_NAME = "herdr-subagents";

/** The helper binary's name inside an artifact. */
export const HELPER_BIN = "herdr-helper";

/** Read the per-harness wake fragment that injects into {{wake}}. */
function readWakeFragment(harness: Harness): string {
  return readFileSync(
    join(srcDir, "skills", "delegate", `${harness}.md`),
    "utf8",
  ).trimEnd();
}

/** Resolve the helper's absolute path inside an artifact root (build-time). */
export function helperPath(artifactRoot: string): string {
  return join(artifactRoot, HELPER_BIN);
}

/**
 * The per-harness map of declared token values — the token contract.
 *
 * Authored explicitly and asserted against the source set in both directions
 * (assertCoverage, before any write):
 *  - source -> map: every `{{...}}` in source, including unknown spellings,
 *    must have an entry, or the build fails. The strong drift guard.
 *  - map -> source: every declared value must be consumed somewhere.
 */
export function tokenMapFor(harness: Harness, artifactRoot: string): TokenMap {
  return {
    wake: readWakeFragment(harness),
    helper: helperPath(artifactRoot),
  };
}

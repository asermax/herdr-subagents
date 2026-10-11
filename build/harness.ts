import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { TokenMap } from "./tokens.ts";
import { srcDir } from "./paths.ts";

export type Harness = "pi" | "claude";

export const PI_PACKAGE_NAME = "pi-herdr-subagents";
export const PI_PACKAGE_SCOPE = "@asermax/pi-herdr-subagents";
export const CLAUDE_PLUGIN_NAME = "herdr-subagents";

/** The helper binary's name inside an artifact. */
export const HELPER_BIN = "herdr-helper";

/** Read the per-harness invoke fragment that injects into {{invoke}}. */
function readInvokeFragment(harness: Harness): string {
  return readFileSync(
    join(srcDir, "skills", "delegate", `invoke-${harness}.md`),
    "utf8",
  ).trimEnd();
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
export function tokenMapFor(harness: Harness): TokenMap {
  return {
    invoke: readInvokeFragment(harness),
  };
}

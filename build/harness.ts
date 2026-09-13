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

/** Read the per-harness wake fragment that injects into {{wake}}. */
function readWakeFragment(harness: Harness): string {
  return readFileSync(
    join(srcDir, "skills", "delegate", `${harness}.md`),
    "utf8",
  ).trimEnd();
}

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
    wake: readWakeFragment(harness),
    invoke: readInvokeFragment(harness),
    // The helper token is claude-only: the claude invoke fragment names the
    // binary (resolved at RUNTIME — $CLAUDE_PLUGIN_ROOT, set by claude at
    // plugin load — so a skill built anywhere works on any install). The pi
    // skill never mentions the helper: the `subagent` tool is the model's
    // only interface on pi, so the map omits the token entirely and the
    // coverage assert would fail any attempt to reintroduce it.
    ...(harness === "claude"
      ? { helper: "${CLAUDE_PLUGIN_ROOT}/bin/" + HELPER_BIN }
      : {}),
  };
}

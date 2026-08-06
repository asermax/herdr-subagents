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
    // Both harnesses resolve the helper at RUNTIME so a skill built anywhere
    // (a CI build included) works on any install, not just the build host:
    //  - claude expands $CLAUDE_PLUGIN_ROOT (set by claude at plugin load).
    //  - pi uses $HERDR_SUBAGENT_HELPER (set by the dev loop, and by the
    //    extension at session start from its resolved helper path), falling
    //    back to the bare `herdr-helper` the package's `bin` puts on PATH.
    // On pi the invoke fragment uses the `subagent` tool, not bash — but the
    // wake fragment still references {{helper}} (the extension's watch spawn),
    // so the token stays in both maps.
    helper:
      harness === "claude"
        ? "${CLAUDE_PLUGIN_ROOT}/bin/" + HELPER_BIN
        : "${HERDR_SUBAGENT_HELPER:-" + HELPER_BIN + "}",
  };
}

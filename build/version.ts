import { readFileSync } from "node:fs";
import { repoRoot } from "./paths.ts";

/**
 * The single version source.
 *
 * Both shipped manifests — the pi package.json and the claude plugin.json —
 * read their version from here. The release pipeline bumps this file and
 * rebuilds, so both artifacts share one version.
 */
export function readVersion(): string {
  const raw = readFileSync(`${repoRoot}/VERSION`, "utf8").trim();
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(raw)) {
    throw new Error(`VERSION file must hold a semver string, got: ${JSON.stringify(raw)}`);
  }
  return raw;
}

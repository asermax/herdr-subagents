import { readFileSync } from "node:fs";
import { repoRoot } from "./paths.ts";

/**
 * The single version source (spec §9 drift-prevention gate).
 *
 * Both shipped manifests — the pi package.json and the claude plugin.json —
 * read their version from here, which reads the repo-root VERSION file. Bump
 * one file; both artifacts and the root package.json move together.
 */
export function readVersion(): string {
  const raw = readFileSync(`${repoRoot}/VERSION`, "utf8").trim();
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(raw)) {
    throw new Error(`VERSION file must hold a semver string, got: ${JSON.stringify(raw)}`);
  }
  return raw;
}

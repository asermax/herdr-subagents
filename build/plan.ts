import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Harness } from "./harness.ts";
import { srcDir } from "./paths.ts";
import type { TokenMap } from "./tokens.ts";

/**
 * One file the build produces for an artifact.
 *
 * - `substitute`: read the source file, run it through the token map.
 * - `copy`: copy the source file verbatim (token-free).
 * - `generate`: produce the file from `render(map)` (for manifests).
 */
export type EmitFile =
  | { dest: string; type: "substitute"; src: string }
  | { dest: string; type: "copy"; src: string }
  | { dest: string; type: "generate"; render: (map: TokenMap) => string };

/** Relative path of the shared parent-facing protocol body in source. */
const PROTOCOL = "shared/protocol.md";

/** Relative path of the static child onboarding in source (token-free). */
const ONBOARDING = "shared/onboarding.md";

/**
 * The file plan for a harness artifact. The skill lives at the path each
 * harness discovers: pi reads the package `skills/` dir; claude reads the
 * plugin's `skills/` dir. The parent-facing body is assembled from the shared
 * protocol (with the wake fragment injected); onboarding is shared and static.
 */
export function filePlan(harness: Harness): EmitFile[] {
  return [
    { dest: "skills/delegate.md", type: "substitute", src: PROTOCOL },
    { dest: "skills/onboarding.md", type: "copy", src: ONBOARDING },
    // The extension ships as source .ts that pi loads via its tsx loader
    // (matches @asermax/pi-cc-plugins' shape). Token-free, so copied verbatim.
    { dest: "extension/index.ts", type: "copy", src: "extension/index.ts" },
    { dest: manifestPath(harness), type: "generate", render: manifestFor(harness) },
  ];
}

function manifestPath(harness: Harness): string {
  return harness === "pi" ? "package.json" : "plugin.json";
}

function manifestFor(harness: Harness): (map: TokenMap) => string {
  if (harness === "pi") {
    return () => JSON.stringify(piManifest(), null, 2) + "\n";
  }
  return () => JSON.stringify(claudeManifest(), null, 2) + "\n";
}

function piManifest() {
  return {
    name: "@asermax/pi-herdr-subagents",
    version: "0.0.0",
    description: "Delegate coding-agent work by spawning other agents as herdr tabs.",
    type: "module",
    license: "MIT",
    // Extension source is shipped so pi's tsx loader can load it from source.
    files: ["skills/", "extension/"],
    pi: {
      extensions: ["./extension/index.ts"],
      skills: ["./skills"],
    },
    peerDependencies: {
      "@earendil-works/pi-coding-agent": "*",
    },
  };
}

function claudeManifest() {
  return {
    name: "herdr-subagents",
    version: "0.0.0",
    description: "Delegate coding-agent work by spawning other agents as herdr tabs.",
  };
}

/** Read the source set that participates in token coverage for a harness. */
export function coverageSources(harness: Harness): string[] {
  // Every file that goes through `substitute` participates in coverage.
  return filePlan(harness)
    .filter((f): f is Extract<EmitFile, { type: "substitute" }> => f.type === "substitute")
    .map((f) => readFileSync(join(srcDir, f.src), "utf8"));
}

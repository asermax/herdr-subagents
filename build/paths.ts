import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root: two levels up from build/ (build/ is <root>/build). */
export const repoRoot = resolve(here, "..");

/** Pure-source root: readable Markdown with substitution tokens. */
export const srcDir = resolve(repoRoot, "src");

/** Build output root. Both artifacts live under here and are gitignored. */
export const outDir = resolve(repoRoot, "build", "out");

/** The pi npm package directory emitted by the build. */
export const piPackageDir = resolve(outDir, "pi");

/** The Claude plugin directory emitted by the build. */
export const claudePluginDir = resolve(outDir, "claude");

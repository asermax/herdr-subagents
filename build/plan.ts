import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Harness } from "./harness.ts";
import { srcDir } from "./paths.ts";
import { substitute } from "./substitute.ts";
import type { TokenMap } from "./tokens.ts";

/**
 * One file the build produces for an artifact.
 *
 * - `substitute`: read the source file, run it through the token map.
 * - `copy`: copy the source file verbatim (token-free).
 * - `generate`: produce the file from `render(map)` (for manifests, or for a
 *   file assembled from multiple sources like the claude SKILL.md, which is
 *   frontmatter plus the substituted protocol body).
 */
export type EmitFile =
  | { dest: string; type: "substitute"; src: string }
  | { dest: string; type: "copy"; src: string }
  | { dest: string; type: "generate"; render: (map: TokenMap) => string };

/** Relative path of the shared parent-facing protocol body in source. */
const PROTOCOL = "shared/protocol.md";

/** Relative path of the static child onboarding in source (token-free). */
const ONBOARDING = "shared/onboarding.md";

/** Relative path of the claude SessionStart onboarding hook (token-free). */
const CLAUDE_ONBOARDING_HOOK = "claude/hooks/onboarding.sh";

/** Relative path of the claude hooks config (token-free, exec form). */
const CLAUDE_HOOKS_JSON = "claude/hooks/hooks.json";

/**
 * The file plan for a harness artifact.
 *
 * pi: the package `skills/` dir holds the delegate body and onboarding; the
 * extension registers the skill via the package manifest.
 *
 * claude: the plugin ships the delegate skill at `skills/delegate/SKILL.md`
 * (the path Claude auto-discovers), the onboarding the hook reads, the
 * `hooks/hooks.json` wiring, and the hook script itself. The manifest lives at
 * `.claude-plugin/plugin.json`, the path Claude reads on enable (spec §9).
 */
export function filePlan(harness: Harness): EmitFile[] {
  if (harness === "pi") {
    return [
      { dest: "skills/delegate.md", type: "substitute", src: PROTOCOL },
      { dest: "skills/onboarding.md", type: "copy", src: ONBOARDING },
      { dest: "package.json", type: "generate", render: () => piManifest() },
    ];
  }

  return [
    {
      dest: "skills/delegate/SKILL.md",
      type: "generate",
      // Frontmatter names the skill `/delegate` (research §5: always set `name`
      // for a generated skill). The body is the shared protocol, substituted.
      render: (map) => claudeDelegateSkill(map),
    },
    { dest: "skills/onboarding.md", type: "copy", src: ONBOARDING },
    { dest: "hooks/hooks.json", type: "copy", src: CLAUDE_HOOKS_JSON },
    { dest: "hooks/onboarding.sh", type: "copy", src: CLAUDE_ONBOARDING_HOOK },
    {
      dest: ".claude-plugin/plugin.json",
      type: "generate",
      render: () => claudeManifest(),
    },
  ];
}

function readSrc(rel: string): string {
  return readFileSync(join(srcDir, rel), "utf8");
}

function claudeDelegateSkill(map: TokenMap): string {
  const frontmatter = [
    "---",
    "name: delegate",
    "description: Delegate work by spawning another agent as a herdr tab.",
    "---",
    "",
  ].join("\n");
  return frontmatter + substitute(readSrc(PROTOCOL), map);
}

function piManifest(): string {
  return (
    JSON.stringify(
      {
        name: "@asermax/pi-herdr-subagents",
        version: "0.0.0",
        description: "Delegate coding-agent work by spawning other agents as herdr tabs.",
        type: "module",
        license: "MIT",
        files: ["skills/"],
        pi: {
          skills: ["./skills"],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function claudeManifest(): string {
  return (
    JSON.stringify(
      {
        name: "herdr-subagents",
        version: "0.0.0",
        description: "Delegate coding-agent work by spawning other agents as herdr tabs.",
        hooks: "hooks/hooks.json",
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * The source files that participate in token coverage for a harness — the set
 * the per-harness map is asserted against in both directions before any write.
 *
 * Both harnesses substitute the shared protocol (the parent-facing body). On
 * claude the substitution happens inside a `generate` step (frontmatter is
 * prepended), so coverage cannot be inferred from the emit type alone; it is
 * declared here instead.
 */
export function coverageSources(_harness: Harness): string[] {
  return [readSrc(PROTOCOL)];
}

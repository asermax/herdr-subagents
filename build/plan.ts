import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { Harness } from "./harness.ts";
import { srcDir } from "./paths.ts";
import { substitute } from "./substitute.ts";
import type { TokenMap } from "./tokens.ts";
import { readVersion } from "./version.ts";

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
  | { dest: string; type: "generate"; render: (map: TokenMap) => string }
  // Bundle a TypeScript entry into a single self-contained ESM file with a
  // node shebang, marked executable. Used to ship the helper binary into an
  // artifact so it can be spawned by absolute path.
  | { dest: string; type: "bundle"; src: string };

const PROTOCOL = "shared/protocol.md";

const ONBOARDING = "shared/onboarding.md";

const CLAUDE_ONBOARDING_HOOK = "claude/hooks/onboarding.sh";

const CLAUDE_HOOKS_JSON = "claude/hooks/hooks.json";

const PI_README = "pi/README.md";

const CLAUDE_README = "claude/README.md";

/**
 * The file plan for a harness artifact.
 *
 * pi: the package `skills/` dir holds the delegate body; onboarding ships in
 * `references/`. The extension registers the skill via the package manifest.
 *
 * claude: the plugin ships the delegate skill at `skills/delegate/SKILL.md`
 * (the path Claude auto-discovers), the onboarding the hook reads, the
 * `hooks/hooks.json` wiring, and the hook script itself. The manifest lives at
 * `.claude-plugin/plugin.json`, the path Claude reads on enable.
 */
export function filePlan(harness: Harness): EmitFile[] {
  if (harness === "pi") {
    return [
      {
        dest: "skills/delegate.md",
        type: "generate",
        // Frontmatter (name + description) so pi registers the skill; the body
        // is the shared protocol with tokens substituted for this harness.
        render: (map) => delegateSkill(map, PI_AGENT_DIRS),
      },
      { dest: "references/onboarding.md", type: "copy", src: ONBOARDING },
      { dest: "README.md", type: "copy", src: PI_README },
      // The extension ships as source .ts that pi loads via its tsx loader
      // (matches @asermax/pi-cc-plugins' shape). Token-free, copied verbatim.
      { dest: "extension/index.ts", type: "copy", src: "extension/index.ts" },
      { dest: "extension/parent-role.ts", type: "copy", src: "extension/parent-role.ts" },
      { dest: "extension/registrar.ts", type: "copy", src: "extension/registrar.ts" },
      // The helper binary, bundled to a single executable at the package root
      // so the extension (and the {{helper}} token) can spawn it by absolute
      // path. herdr-helper resolves relative to the package root.
      { dest: "herdr-helper", type: "bundle", src: "helper/cli.ts" },
      { dest: "package.json", type: "generate", render: () => piManifest(readVersion()) },
    ];
  }

  return [
    {
      dest: "skills/delegate/SKILL.md",
      type: "generate",
      // Frontmatter names the skill `/delegate`; the body is the shared
      // protocol, substituted. Both harnesses share the same skill generator.
      render: (map) => delegateSkill(map),
    },
    { dest: "references/onboarding.md", type: "copy", src: ONBOARDING },
    { dest: "README.md", type: "copy", src: CLAUDE_README },
    { dest: "hooks/hooks.json", type: "copy", src: CLAUDE_HOOKS_JSON },
    { dest: "hooks/onboarding.sh", type: "copy", src: CLAUDE_ONBOARDING_HOOK },
    // The helper binary, bundled next to the delegate skill so
    // $CLAUDE_PLUGIN_ROOT/skills/herdr-helper (the {{helper}} token) resolves
    // at runtime under the plugin's install dir.
    { dest: "skills/herdr-helper", type: "bundle", src: "helper/cli.ts" },
    {
      dest: ".claude-plugin/plugin.json",
      type: "generate",
      render: () => claudeManifest(readVersion()),
    },
    // The same tree doubles as a single-plugin marketplace: the
    // orphan claude-marketplace branch holds this file at its root so
    // `claude plugin install --marketplace asermax/herdr-subagents` works.
    {
      dest: ".claude-plugin/marketplace.json",
      type: "generate",
      render: () => claudeMarketplace(readVersion()),
    },
  ];
}

function readSrc(rel: string): string {
  return readFileSync(join(srcDir, rel), "utf8");
}

function delegateSkill(map: TokenMap, suffix = ""): string {
  const frontmatter = [
    "---",
    "name: delegate",
    "description: Delegate work by spawning another agent as a herdr tab.",
    "---",
    "",
  ].join("\n");
  return frontmatter + substitute(readSrc(PROTOCOL), map) + suffix;
}

// pi-only: names the concrete directory the extension scans for agent
// definitions, so the agent can look there before picking an --agent name.
// `.pi/agents/` is scanned recursively.
const PI_AGENT_DIRS = `

## Agent definitions on pi

Agent names you can pass to \`--agent\` are defined as \`.md\` files under \`.pi/agents/\` (scanned recursively). Run \`ls -R .pi/agents\` to see which agents are available before picking a name.
`;

function piManifest(version: string): string {
  return (
    JSON.stringify(
      {
        name: "@asermax/pi-herdr-subagents",
        version,
        description: "Delegate coding-agent work by spawning other agents as herdr tabs.",
        type: "module",
        license: "MIT",
        keywords: ["pi-package", "pi-extension"],
        repository: {
          type: "git",
          url: "git+https://github.com/asermax/herdr-subagents.git",
        },
        publishConfig: {
          access: "public",
        },
        // The helper binary, invokable by absolute path from the extension and
        // the {{helper}} skill token.
        bin: {
          "herdr-helper": "herdr-helper",
        },
        // Extension source + the helper binary ship in the tarball.
        files: ["skills/", "references/", "extension/", "herdr-helper", "README.md"],
        pi: {
          extensions: ["./extension/index.ts"],
          skills: ["./skills"],
        },
        peerDependencies: {
          "@earendil-works/pi-coding-agent": "*",
        },
        peerDependenciesMeta: {
          "@earendil-works/pi-coding-agent": {
            optional: true,
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function claudeManifest(version: string): string {
  return (
    JSON.stringify(
      {
        name: "herdr-subagents",
        version,
        description: "Delegate coding-agent work by spawning other agents as herdr tabs.",
        // Hooks are discovered by convention at hooks/hooks.json — plugin.json
        // carries no hooks pointer.
        author: { name: "Agustín Carrasco" },
        repository: "https://github.com/asermax/herdr-subagents",
        homepage: "https://github.com/asermax/herdr-subagents",
        license: "MIT",
        keywords: ["delegation", "subagents", "herdr"],
      },
      null,
      2,
    ) + "\n"
  );
}

function claudeMarketplace(version: string): string {
  return (
    JSON.stringify(
      {
        name: "herdr-subagents",
        description: "herdr-subagents — coding-agent subagents as herdr tabs.",
        owner: {
          name: "Agustín Carrasco",
          url: "https://github.com/asermax",
        },
        plugins: [
          {
            name: "herdr-subagents",
            source: "./",
            description: "Delegate coding-agent work by spawning other agents as herdr tabs.",
            version,
            category: "developer",
            keywords: ["delegation", "subagents", "herdr"],
          },
        ],
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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The registrar is a pure module (no `pi`): it resolves agent-definition
// `.md` files from `.pi/agents/` (scanned recursively, including subdirectories
// like `cc-plugins/`) and `.claude/agents/`, applies precedence and field
// mapping, and exposes a name lookup. No event bus — the filesystem is the
// shared medium with pi-cc-plugins.
//
// Canonical Claude frontmatter fields:
//   name, description (required); tools, disallowedTools, model, effort,
//   maxTurns, skills, mcpServers, hooks, memory, background, isolation, color.
//   package (pi-cc-plugins converter → namespace).

import { resolveAgents, resolveAgentByName } from "../src/extension/registrar.js";

/** A self-contained temp project: projectRoot with .claude/agents + .pi/agents. */
interface Fixture {
  root: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "herdr-registrar-"));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeAgent(dir: string, file: string, frontmatter: string, body = ""): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}`);
  return path;
}

/** Minimal valid agent frontmatter. */
const BASE_FM = "name: reviewer\ndescription: reviews code";

describe("resolveAgents — directory resolution + precedence", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.cleanup();
  });

  it("loads a single agent from .claude/agents", () => {
    const path = writeAgent(join(fx.root, ".claude", "agents"), "reviewer.md", BASE_FM);

    const { agents, warnings } = resolveAgents({ cwd: fx.root });

    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("reviewer");
    expect(agents[0]!.path).toBe(path);
    expect(agents[0]!.source).toBe("project");
    expect(agents[0]!.namespace).toBe("");
    expect(warnings).toEqual([]);
  });

  it("project .claude/agents overrides user .claude/agents for the same name", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "herdr-user-"));
    try {
      writeAgent(join(fakeHome, ".claude", "agents"), "reviewer.md", "name: reviewer\ndescription: user copy");
      writeAgent(join(fx.root, ".claude", "agents"), "reviewer.md", "name: reviewer\ndescription: project copy");

      const { agents } = resolveAgents({ cwd: fx.root, userDir: fakeHome });

      expect(agents).toHaveLength(1);
      expect(agents[0]!.description).toBe("project copy");
      expect(agents[0]!.source).toBe("project");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("within a scope, .pi/agents overrides .claude/agents for the same name", () => {
    writeAgent(join(fx.root, ".claude", "agents"), "reviewer.md", "name: reviewer\ndescription: claude default");
    writeAgent(join(fx.root, ".pi", "agents"), "reviewer.md", "name: reviewer\ndescription: pi override");

    const { agents } = resolveAgents({ cwd: fx.root });

    expect(agents).toHaveLength(1);
    expect(agents[0]!.description).toBe("pi override");
  });

  it("project .pi/agents wins over user .claude/agents and user .pi/agents", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "herdr-user-"));
    try {
      writeAgent(join(fakeHome, ".claude", "agents"), "reviewer.md", "name: reviewer\ndescription: user claude");
      writeAgent(join(fakeHome, ".pi", "agents"), "reviewer.md", "name: reviewer\ndescription: user pi");
      writeAgent(join(fx.root, ".pi", "agents"), "reviewer.md", "name: reviewer\ndescription: project pi");

      const { agents } = resolveAgents({ cwd: fx.root, userDir: fakeHome });

      expect(agents).toHaveLength(1);
      expect(agents[0]!.description).toBe("project pi");
      expect(agents[0]!.source).toBe("project");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("warns on a duplicate name in the same directory and keeps the first", () => {
    // Resolution order within a dir is alphabetical by filename for determinism.
    writeAgent(join(fx.root, ".claude", "agents"), "a-reviewer.md", "name: reviewer\ndescription: first file");
    writeAgent(join(fx.root, ".claude", "agents"), "b-reviewer.md", "name: reviewer\ndescription: second file");

    const { agents, warnings } = resolveAgents({ cwd: fx.root });

    expect(agents).toHaveLength(1);
    expect(agents[0]!.description).toBe("first file");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("reviewer");
  });

  it("agents with the same name in DIFFERENT directories are not a warning (precedence resolves them)", () => {
    writeAgent(join(fx.root, ".claude", "agents"), "reviewer.md", "name: reviewer\ndescription: claude");
    writeAgent(join(fx.root, ".pi", "agents"), "reviewer.md", "name: reviewer\ndescription: pi");

    const { agents, warnings } = resolveAgents({ cwd: fx.root });

    expect(agents).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("ignores files without required name or description", () => {
    writeAgent(join(fx.root, ".claude", "agents"), "no-desc.md", "name: nodesc");
    writeAgent(join(fx.root, ".claude", "agents"), "no-name.md", "description: missing name");
    writeAgent(join(fx.root, ".claude", "agents"), "good.md", BASE_FM);

    const { agents } = resolveAgents({ cwd: fx.root });

    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("reviewer");
  });

  it("does not read .claude/agents when the dirs are absent (no error)", () => {
    const { agents } = resolveAgents({ cwd: fx.root });
    expect(agents).toEqual([]);
  });

  it("defaults userDir to os.homedir() when not provided", () => {
    // Smoke test: must not throw and must not pick up unrelated files. We only
    // assert it runs; homedir contents are environment-dependent.
    const { agents } = resolveAgents({ cwd: fx.root });
    expect(Array.isArray(agents)).toBe(true);
  });
});

describe("resolveAgents — field mapping", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });

  afterEach(() => {
    fx.cleanup();
  });

  it("maps name and description directly", () => {
    writeAgent(join(fx.root, ".claude", "agents"), "reviewer.md", BASE_FM);

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    expect(agent!.name).toBe("reviewer");
    expect(agent!.description).toBe("reviews code");
  });

  it("maps effort → thinking", () => {
    writeAgent(
      join(fx.root, ".claude", "agents"),
      "reviewer.md",
      "name: reviewer\ndescription: x\neffort: high",
    );

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    expect(agent!.thinking).toBe("high");
  });

  it("maps maxTurns → turnBudget", () => {
    writeAgent(
      join(fx.root, ".claude", "agents"),
      "reviewer.md",
      "name: reviewer\ndescription: x\nmaxTurns: 12",
    );

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    expect(agent!.turnBudget).toEqual({ maxTurns: 12 });
  });

  it("passes skills through as a list", () => {
    writeAgent(
      join(fx.root, ".claude", "agents"),
      "reviewer.md",
      "name: reviewer\ndescription: x\nskills:\n  - code-review\n  - tdd",
    );

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    expect(agent!.skills).toEqual(["code-review", "tdd"]);
  });

  it("captures the Markdown body below the frontmatter as the system prompt", () => {
    // The Claude format puts the system prompt in the file body, after the
    // frontmatter fence. parseAgentFile must carry it onto the record so the
    // extension can append it at launch.
    writeAgent(
      join(fx.root, ".claude", "agents"),
      "reviewer.md",
      "name: reviewer\ndescription: x",
      "You are a code reviewer. Be thorough and kind.",
    );

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    expect(agent!.systemPrompt).toBe("You are a code reviewer. Be thorough and kind.");
  });

  it("omits systemPrompt when the file has no body", () => {
    writeAgent(join(fx.root, ".claude", "agents"), "reviewer.md", BASE_FM);

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    expect(agent!.systemPrompt).toBeUndefined();
  });

  it("drops tools, disallowedTools, model, mcpServers silently", () => {
    writeAgent(
      join(fx.root, ".claude", "agents"),
      "reviewer.md",
      "name: reviewer\ndescription: x\ntools: Read, Grep\ndisallowedTools: Bash\nmodel: sonnet\nmcpServers:\n  - github",
    );

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    // Accepted by the parser and intentionally not carried onto the record.
    expect(agent!).not.toHaveProperty("tools");
    expect(agent!).not.toHaveProperty("disallowedTools");
    expect(agent!).not.toHaveProperty("model");
    expect(agent!).not.toHaveProperty("mcpServers");
  });

  it("drops background, isolation, color, memory, hooks silently", () => {
    writeAgent(
      join(fx.root, ".claude", "agents"),
      "reviewer.md",
      "name: reviewer\ndescription: x\nbackground: true\nisolation: worktree\ncolor: red\nmemory: project",
    );

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    expect(agent!).not.toHaveProperty("background");
    expect(agent!).not.toHaveProperty("isolation");
    expect(agent!).not.toHaveProperty("color");
    expect(agent!).not.toHaveProperty("memory");
    expect(agent!).not.toHaveProperty("hooks");
  });

  it("applies fixed application defaults: system prompt appends, context inherits, skills inherit", () => {
    writeAgent(join(fx.root, ".claude", "agents"), "reviewer.md", BASE_FM);

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    // The Claude format has no toggles for these, so they are fixed:
    // system prompt APPENDS (not Claude's replace), project context INHERITS,
    // skills INHERIT.
    expect(agent!.systemPromptMode).toBe("append");
    expect(agent!.inheritProjectContext).toBe(true);
    expect(agent!.inheritSkills).toBe(true);
  });

  it("a deliberately restricted agent (tools: limited) becomes unrestricted on pi", () => {
    // The tools drop means a restricted agent loses its restriction on pi.
    // Accepted knowingly. Asserted so the acceptance is visible.
    writeAgent(
      join(fx.root, ".claude", "agents"),
      "reviewer.md",
      "name: reviewer\ndescription: x\ntools: Read",
    );

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    expect(agent!).not.toHaveProperty("tools");
  });
});

describe("resolveAgents — recursive scan + package namespace", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it("discovers agents in subdirectories of .pi/agents (e.g. cc-plugins/)", () => {
    writeAgent(
      join(fx.root, ".pi", "agents", "cc-plugins"),
      "superpowers--searcher.md",
      "name: searcher\ndescription: searches docs\npackage: superpowers",
    );

    const { agents } = resolveAgents({ cwd: fx.root });

    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("searcher");
  });

  it("reads the package frontmatter field as the namespace", () => {
    writeAgent(
      join(fx.root, ".pi", "agents", "cc-plugins"),
      "superpowers--searcher.md",
      "name: searcher\ndescription: searches docs\npackage: superpowers",
    );

    const { agents } = resolveAgents({ cwd: fx.root });

    expect(agents[0]!.namespace).toBe("superpowers");
  });

  it("agents without a package field are bare (empty namespace)", () => {
    writeAgent(join(fx.root, ".claude", "agents"), "reviewer.md", BASE_FM);

    const { agents } = resolveAgents({ cwd: fx.root });

    expect(agents[0]!.namespace).toBe("");
  });

  it("namespaced agents from different packages coexist without collision", () => {
    writeAgent(
      join(fx.root, ".pi", "agents", "cc-plugins"),
      "alpha--dup.md",
      "name: dup\ndescription: alpha copy\npackage: alpha",
    );
    writeAgent(
      join(fx.root, ".pi", "agents", "cc-plugins"),
      "beta--dup.md",
      "name: dup\ndescription: beta copy\npackage: beta",
    );

    const { agents } = resolveAgents({ cwd: fx.root });

    expect(agents).toHaveLength(2);
    const ns = agents.map((a) => a.namespace).sort();
    expect(ns).toEqual(["alpha", "beta"]);
  });
});

describe("resolveAgentByName", () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = makeFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  it("matches a bare name when the agent has no namespace", () => {
    writeAgent(join(fx.root, ".claude", "agents"), "reviewer.md", BASE_FM);
    const { agents } = resolveAgents({ cwd: fx.root });

    expect(resolveAgentByName(agents, "reviewer")?.description).toBe("reviews code");
  });

  it("matches a qualified namespace:name", () => {
    writeAgent(
      join(fx.root, ".pi", "agents", "cc-plugins"),
      "superpowers--searcher.md",
      "name: searcher\ndescription: qualified\npackage: superpowers",
    );
    const { agents } = resolveAgents({ cwd: fx.root });

    expect(resolveAgentByName(agents, "superpowers:searcher")?.description).toBe("qualified");
  });

  it("falls back to bare-name match for a namespaced agent", () => {
    writeAgent(
      join(fx.root, ".pi", "agents", "cc-plugins"),
      "superpowers--searcher.md",
      "name: searcher\ndescription: fallback\npackage: superpowers",
    );
    const { agents } = resolveAgents({ cwd: fx.root });

    expect(resolveAgentByName(agents, "searcher")?.description).toBe("fallback");
  });

  it("returns undefined for an unknown name", () => {
    const { agents } = resolveAgents({ cwd: fx.root });
    expect(resolveAgentByName(agents, "ghost")).toBeUndefined();
  });
});

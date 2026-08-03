import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The registrar is a pure module (no `pi`): it resolves Claude-format
// `.claude/agents/*.md` definitions, applies precedence and field mapping, and
// replaces registrations per (source, namespace) rather than accumulating.
// Tested here at the module seam, then exercised through the factory in
// extension.test.ts (Seam 2).
//
// Canonical Claude frontmatter fields (research claude-code-surface.md):
//   name, description (required); tools, disallowedTools, model, effort,
//   maxTurns, skills, mcpServers, hooks, memory, background, isolation, color,
//   initialPrompt (optional).

import { createRegistrar, resolveAgents } from "../src/extension/registrar.js";

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
    // Bare names: project overrides user (spec §7).
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
    // .pi/agents is the override knob; .claude/agents the shared default (§7).
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
    // Same name in the same directory: warn, first wins (spec §7). Resolution
    // order within a dir is alphabetical by filename for determinism.
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

  it("maps initialPrompt to an injected first user turn", () => {
    writeAgent(
      join(fx.root, ".claude", "agents"),
      "reviewer.md",
      "name: reviewer\ndescription: x\ninitialPrompt: Start by reading the diff.",
    );

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    expect(agent!.initialPrompt).toBe("Start by reading the diff.");
  });

  it("drops tools, disallowedTools, model, mcpServers silently", () => {
    writeAgent(
      join(fx.root, ".claude", "agents"),
      "reviewer.md",
      "name: reviewer\ndescription: x\ntools: Read, Grep\ndisallowedTools: Bash\nmodel: sonnet\nmcpServers:\n  - github",
    );

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    // None of these survive onto the resolved record. (They are accepted by the
    // parser and intentionally not carried — spec §7.)
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

    // The Claude format has no toggles for these (spec §7), so they are fixed:
    // system prompt APPENDS (not Claude's replace), project context INHERITS,
    // skills INHERIT.
    expect(agent!.systemPromptMode).toBe("append");
    expect(agent!.inheritProjectContext).toBe(true);
    expect(agent!.inheritSkills).toBe(true);
  });

  it("a deliberately restricted agent (tools: limited) becomes unrestricted on pi", () => {
    // The tools drop means a restricted agent loses its restriction on pi.
    // Accepted knowingly (spec §7). Asserted so the acceptance is visible.
    writeAgent(
      join(fx.root, ".claude", "agents"),
      "reviewer.md",
      "name: reviewer\ndescription: x\ntools: Read",
    );

    const [agent] = resolveAgents({ cwd: fx.root }).agents;

    expect(agent!).not.toHaveProperty("tools");
  });
});

describe("registrar — replace per (source, namespace)", () => {
  it("starts empty", () => {
    const registrar = createRegistrar();
    expect(registrar.list()).toEqual([]);
  });

  it("a bus registration with one path registers that agent", () => {
    const fx = makeFixture();
    try {
      const path = writeAgent(join(fx.root, "pkg", "agents"), "researcher.md", "name: researcher\ndescription: digs");

      const registrar = createRegistrar();
      registrar.register({
        version: 1,
        paths: [path],
        namespace: "my-plugin",
        source: "package",
      });

      expect(registrar.list()).toHaveLength(1);
      expect(registrar.list()[0]!.name).toBe("researcher");
      expect(registrar.list()[0]!.namespace).toBe("my-plugin");
      expect(registrar.list()[0]!.source).toBe("package");
    } finally {
      fx.cleanup();
    }
  });

  it("replaces per (source, namespace) — a second emit for the same key drops the first set", () => {
    // A session switch drops the previous project's agents and picks up the new
    // ones with no staleness (spec §7). Registrations REPLACE per
    // (source, namespace) rather than accumulating.
    const fx = makeFixture();
    try {
      const pathV1 = writeAgent(join(fx.root, "v1", "agents"), "a.md", "name: alpha\ndescription: v1");
      const pathV2 = writeAgent(join(fx.root, "v2", "agents"), "b.md", "name: beta\ndescription: v2");

      const registrar = createRegistrar();
      registrar.register({ version: 1, paths: [pathV1], namespace: "", source: "project" });
      expect(registrar.list().map((a) => a.name)).toEqual(["alpha"]);

      registrar.register({ version: 1, paths: [pathV2], namespace: "", source: "project" });
      expect(registrar.list().map((a) => a.name)).toEqual(["beta"]);
    } finally {
      fx.cleanup();
    }
  });

  it("different (source, namespace) keys accumulate independently", () => {
    const fx = makeFixture();
    try {
      const projectPath = writeAgent(join(fx.root, "p", "agents"), "a.md", "name: alpha\ndescription: p");
      const pkgPath = writeAgent(join(fx.root, "pkg", "agents"), "b.md", "name: beta\ndescription: pkg");

      const registrar = createRegistrar();
      registrar.register({ version: 1, paths: [projectPath], namespace: "", source: "project" });
      registrar.register({ version: 1, paths: [pkgPath], namespace: "plugin", source: "package" });

      const names = registrar.list().map((a) => a.name).sort();
      expect(names).toEqual(["alpha", "beta"]);
    } finally {
      fx.cleanup();
    }
  });

  it("same qualified name under two sources: higher rank wins at lookup", () => {
    // source maps onto the precedence rank (spec §8). When the same qualified
    // name is registered under two sources, the higher-rank source wins.
    const fx = makeFixture();
    try {
      const pkgPath = writeAgent(join(fx.root, "pkg"), "r.md", "name: dup\ndescription: package copy");
      const projPath = writeAgent(join(fx.root, "proj"), "r.md", "name: dup\ndescription: project copy");

      const registrar = createRegistrar();
      // Both standalone (empty namespace) under the bare name "dup": project
      // outranks package.
      registrar.register({ version: 1, paths: [pkgPath], namespace: "", source: "package" });
      registrar.register({ version: 1, paths: [projPath], namespace: "", source: "project" });

      const agent = registrar.resolve("dup");
      expect(agent?.description).toBe("project copy");
    } finally {
      fx.cleanup();
    }
  });

  it("a namespaced plugin agent does not shadow a standalone agent of the same bare name", () => {
    const fx = makeFixture();
    try {
      const standalonePath = writeAgent(join(fx.root, "p"), "r.md", "name: dup\ndescription: standalone");
      const pluginPath = writeAgent(join(fx.root, "pkg"), "r.md", "name: dup\ndescription: plugin copy");

      const registrar = createRegistrar();
      registrar.register({ version: 1, paths: [standalonePath], namespace: "", source: "project" });
      registrar.register({ version: 1, paths: [pluginPath], namespace: "my-plugin", source: "package" });

      // Distinct identities — both resolve under their own qualified name.
      expect(registrar.resolve("dup")?.description).toBe("standalone");
      expect(registrar.resolve("my-plugin:dup")?.description).toBe("plugin copy");
      expect(registrar.list()).toHaveLength(2);
    } finally {
      fx.cleanup();
    }
  });

  it("a namespaced plugin agent resolves only by its prefixed name", () => {
    const fx = makeFixture();
    try {
      const path = writeAgent(join(fx.root, "pkg"), "r.md", "name: researcher\ndescription: plugin agent");

      const registrar = createRegistrar();
      registrar.register({ version: 1, paths: [path], namespace: "my-plugin", source: "package" });

      // Plugin-shipped agents are namespaced and require the prefix (spec §7).
      expect(registrar.resolve("researcher")).toBeUndefined();
      expect(registrar.resolve("my-plugin:researcher")?.description).toBe("plugin agent");
    } finally {
      fx.cleanup();
    }
  });
});

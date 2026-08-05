import { describe, it, expect, vi } from "vitest";
import { resolve, join } from "node:path";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Seam 2: the extension factory with a fake `pi`.
// We build a mock pi that captures event registrations, flags, and `pi.events`
// bus subscriptions, then invoke the captured handlers directly — the shape
// established by `@asermax/pi-cc-plugins`' `tests/extension.test.ts`.
//
// Covers the child-side onboarding injection and the agent-resolution role:
// the `--agent` flag, the registrar (precedence + field mapping +
// replace-per-(source,namespace)), and the `pi.events` presence handshake. The
// parent-side watcher registers into the same factory later.

import extension, { _setResolveCwd } from "../src/extension/index.js";

const ONBOARDING_PATH = resolve(import.meta.dirname, "..", "src", "shared", "onboarding.md");

/** Write a Claude-format agent file into a temp project's .claude/agents. */
function makeAgentProject(frontmatter: string, body = ""): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-fs-agent-"));
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(join(root, ".claude", "agents", "agent.md"), `---\n${frontmatter}\n---\n${body}`);
  return root;
}

/** Write + register an agent from the filesystem, returning a cleanup fn. */
function setupFsAgent(frontmatter: string, body = ""): () => void {
  const root = makeAgentProject(frontmatter, body);
  _setResolveCwd(root);
  return () => rmSync(root, { recursive: true, force: true });
}

/** A handler captured by the fake pi, for either a lifecycle event or a bus channel. */
type CapturedHandler = (event: any, ctx?: any) => any;

interface RegisteredFlag {
  options: { type: "boolean" | "string"; description?: string; default?: boolean | string };
}

interface FakePi {
  on: ReturnType<typeof vi.fn>;
  registerFlag: ReturnType<typeof vi.fn>;
  getFlag: ReturnType<typeof vi.fn>;
  events: {
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
  };
  sendMessage: ReturnType<typeof vi.fn>;
  handlers: Map<string, CapturedHandler>;
  busHandlers: Map<string, (data: unknown) => void>;
  flags: Map<string, RegisteredFlag>;
  /** Values pi reconciled from CLI argv (seeded by a test to mimic arg parsing). */
  flagValues: Map<string, boolean | string>;
}

/**
 * Build a fake pi that captures lifecycle handler registrations, flag
 * registrations, and bus subscriptions. `getFlag` reads the reconciled CLI
 * value when one was seeded, else the registered default — mirroring pi's
 * `runtime.flagValues` flow: argv is reconciled against registered flags, and
 * `getFlag` reads the result.
 */
function createFakePi(): FakePi {
  const handlers = new Map<string, CapturedHandler>();
  const busHandlers = new Map<string, (data: unknown) => void>();
  const flags = new Map<string, RegisteredFlag>();
  const flagValues = new Map<string, boolean | string>();

  return {
    on: vi.fn((event: string, handler: CapturedHandler) => {
      handlers.set(event, handler);
    }),
    registerFlag: vi.fn((name: string, options: RegisteredFlag["options"]) => {
      flags.set(name, { options });
      // pi seeds the registered default at load.
      if (options.default !== undefined) {
        flagValues.set(name, options.default);
      }
    }),
    getFlag: vi.fn((name: string) => flagValues.get(name)),
    events: {
      on: vi.fn((channel: string, handler: (data: unknown) => void) => {
        busHandlers.set(channel, handler);
        // `pi.events.on` returns an unsubscribe function (see pi's EventBus).
        return () => {
          busHandlers.delete(channel);
        };
      }),
      // pi's bus dispatches synchronously to every registered handler for the
      // channel. Model that so a handshake where one side emits and the other
      // has already subscribed actually converges.
      emit: vi.fn((channel: string, data: unknown) => {
        const handler = busHandlers.get(channel);
        if (handler) handler(data);
      }),
    },
    // The parent-side role registers a session_start handler (captured in
    // `handlers`) to capture ctx.ui for the footer status line, and calls
    // sendMessage lazily on a terminal-state wake. sendMessage is
    // pipe-fitting and is NOT asserted here.
    sendMessage: vi.fn(),
    handlers,
    busHandlers,
    flags,
    flagValues,
  };
}

/** Save and restore environment variables between tests. */
function withEnv(vars: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

describe("extension factory", () => {
  it("exports a default factory function", () => {
    expect(typeof extension).toBe("function");
  });

  it("registers a before_agent_start handler at factory time", () => {
    const pi = createFakePi();
    extension(pi as any);

    expect(pi.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
  });

  it("registers a session_shutdown handler at factory time", () => {
    const pi = createFakePi();
    extension(pi as any);

    expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
  });

  it("registers a session_start handler to capture ctx.ui for the footer status line", () => {
    // The parent role's watch callback has no handler ctx, so it captures
    // ctx.ui once at session_start. The handler must be registered at factory
    // time so the first status change can reach the footer.
    const pi = createFakePi();
    extension(pi as any);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
  });
});

describe("--agent flag", () => {
  // herdr launches a child as `herdr agent start --kind pi -- --agent <name>`;
  // the flag carries the agent name into the session. Same shape as pi's
  // `--fff-mode`: a string flag with no default, registered declaratively so
  // pi matches it against CLI argv — no process.argv parsing.
  it("registers the agent flag as a string flag at factory time", () => {
    const pi = createFakePi();
    extension(pi as any);

    expect(pi.registerFlag).toHaveBeenCalledWith("agent", { type: "string" });
  });

  it("has no default — an unset flag reads undefined, not a sentinel", () => {
    // `--fff-mode` registers `type: "string"` with no default, resolved as
    // flag → env → default. The agent flag follows the same shape.
    const pi = createFakePi();
    extension(pi as any);

    expect(pi.flags.get("agent")?.options.type).toBe("string");
    expect(pi.flags.get("agent")?.options.default).toBeUndefined();
    expect(pi.getFlag("agent")).toBeUndefined();
  });

  it("herdr's `-- --agent <name>` argv reaches pi.getFlag('agent')", () => {
    // Simulate pi's reconciliation: the `--agent reviewer` argv is reconciled
    // against the registered flag and lands in flagValues. The extension reads
    // it back through the same getFlag it registered.
    const pi = createFakePi();
    extension(pi as any);

    pi.flagValues.set("agent", "reviewer");

    expect(pi.getFlag("agent")).toBe("reviewer");
  });
});

describe("before_agent_start onboarding injection", () => {
  const onboarding = readFileSync(ONBOARDING_PATH, "utf8");

  it("appends onboarding to event.systemPrompt when HERDR_SUBAGENT is set", async () => {
    const restore = withEnv({ HERDR_SUBAGENT: "1" });
    try {
      const pi = createFakePi();
      extension(pi as any);

      const handler = pi.handlers.get("before_agent_start")!;
      const result = await handler({
        type: "before_agent_start",
        prompt: "do the thing",
        systemPrompt: "BASE PROMPT",
        systemPromptOptions: {} as any,
      });

      expect(result.systemPrompt).toBe("BASE PROMPT\n\n" + onboarding);
      // The original base must remain intact, prepended rather than replaced.
      expect(result.systemPrompt.startsWith("BASE PROMPT")).toBe(true);
    } finally {
      restore();
    }
  });

  it("is a no-op (returns no systemPrompt) when the gate is absent", async () => {
    const restore = withEnv({ HERDR_SUBAGENT: undefined });
    try {
      const pi = createFakePi();
      extension(pi as any);

      const handler = pi.handlers.get("before_agent_start")!;
      const result = await handler({
        type: "before_agent_start",
        prompt: "do the thing",
        systemPrompt: "BASE PROMPT",
        systemPromptOptions: {} as any,
      });

      // No-op: a normal session pays nothing. Returning undefined means pi
      // leaves the prompt unchanged.
      expect(result).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("appends even when the gate value is not exactly 1 (presence is what matters)", async () => {
    // CONTEXT.md: "the gate — `HERDR_SUBAGENT=1`, the environment variable
    // whose presence means 'this session is a child'." Presence governs, not
    // the exact value.
    const restore = withEnv({ HERDR_SUBAGENT: "true" });
    try {
      const pi = createFakePi();
      extension(pi as any);

      const handler = pi.handlers.get("before_agent_start")!;
      const result = await handler({
        type: "before_agent_start",
        prompt: "x",
        systemPrompt: "BASE",
        systemPromptOptions: {} as any,
      });

      expect(result.systemPrompt).toBe("BASE\n\n" + onboarding);
    } finally {
      restore();
    }
  });

  it("appends to an empty system prompt without leading whitespace drift", async () => {
    const restore = withEnv({ HERDR_SUBAGENT: "1" });
    try {
      const pi = createFakePi();
      extension(pi as any);

      const handler = pi.handlers.get("before_agent_start")!;
      const result = await handler({
        type: "before_agent_start",
        prompt: "x",
        systemPrompt: "",
        systemPromptOptions: {} as any,
      });

      // Empty base → just the onboarding, no stray leading newline.
      expect(result.systemPrompt).toBe(onboarding);
    } finally {
      restore();
    }
  });

  it("onboarding content comes from the shared static source unchanged", async () => {
    // This slice READS src/shared/onboarding.md; it does not own or transform
    // it. The injected text must equal the file byte for byte.
    const restore = withEnv({ HERDR_SUBAGENT: "1" });
    try {
      const pi = createFakePi();
      extension(pi as any);

      const handler = pi.handlers.get("before_agent_start")!;
      const result = await handler({
        type: "before_agent_start",
        prompt: "x",
        systemPrompt: "BASE",
        systemPromptOptions: {} as any,
      });

      expect(result.systemPrompt.endsWith(onboarding)).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("before_agent_start: --agent consumption", () => {
  // A child launched as `herdr agent start --kind pi -- --agent <name>`
  // must get the resolved agent's system prompt appended. The `--agent` flag
  // is read back through pi.getFlag.
  const onboarding = readFileSync(ONBOARDING_PATH, "utf8");

  function beforeHandler(pi: FakePi): CapturedHandler {
    const h = pi.handlers.get("before_agent_start");
    if (!h) throw new Error("before_agent_start handler not registered");
    return h;
  }

  function fire(pi: FakePi, systemPrompt = "BASE"): Promise<any> {
    return beforeHandler(pi)({
      type: "before_agent_start",
      prompt: "x",
      systemPrompt,
      systemPromptOptions: {} as any,
    });
  }

  /** Write an agent to the filesystem so resolveAgents picks it up. */
  function registerAgent(_pi: FakePi, _file: string, frontmatter: string, body = ""): void {
    setupFsAgent(frontmatter, body);
  }

  it("appends a resolved agent's system prompt to the base prompt", async () => {
    // Clear the gate so this asserts the agent append alone, independent of the
    // ambient HERDR_SUBAGENT value the test process may inherit.
    const restore = withEnv({ HERDR_SUBAGENT: undefined });
    try {
      const pi = createFakePi();
      extension(pi as any);
      registerAgent(pi, "reviewer.md", "name: reviewer\ndescription: digs", "You review code thoroughly.");
      pi.flagValues.set("agent", "reviewer");

      const result = await fire(pi);

      expect(result.systemPrompt).toBe("BASE\n\nYou review code thoroughly.");
    } finally {
      restore();
    }
  });

  it("composes onboarding and the agent prompt: onboarding first, agent last", async () => {
    // When BOTH HERDR_SUBAGENT is set AND --agent is passed, the child gets
    // onboarding AND the agent's system prompt. Order: base → onboarding
    // (general herdr-child framing) → agent role (most specific last).
    const restore = withEnv({ HERDR_SUBAGENT: "1" });
    try {
      const pi = createFakePi();
      extension(pi as any);
      registerAgent(pi, "reviewer.md", "name: reviewer\ndescription: digs", "AGENT ROLE PROMPT");
      pi.flagValues.set("agent", "reviewer");

      const result = await fire(pi);

      expect(result.systemPrompt).toBe(`BASE\n\n${onboarding}\n\nAGENT ROLE PROMPT`);
    } finally {
      restore();
    }
  });

  it("applies only the agent prompt when HERDR_SUBAGENT is absent", async () => {
    // --agent is independent of the onboarding gate: a child launched with an
    // agent but without HERDR_SUBAGENT still gets the agent's prompt.
    const restore = withEnv({ HERDR_SUBAGENT: undefined });
    try {
      const pi = createFakePi();
      extension(pi as any);
      registerAgent(pi, "reviewer.md", "name: reviewer\ndescription: digs", "AGENT ONLY");
      pi.flagValues.set("agent", "reviewer");

      const result = await fire(pi);

      expect(result.systemPrompt).toBe("BASE\n\nAGENT ONLY");
    } finally {
      restore();
    }
  });

  it("is a no-op when --agent is passed but resolves to nothing", async () => {
    const restore = withEnv({ HERDR_SUBAGENT: undefined });
    try {
      const pi = createFakePi();
      extension(pi as any);
      pi.flagValues.set("agent", "ghost");

      const result = await fire(pi);

      expect(result).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("warns to stderr when a resolved agent declares unapplied spawn-time fields", async () => {
    // thinking/turnBudget/skills cannot be applied from before_agent_start.
    // The extension surfaces this as a one-line stderr warning rather than
    // silently dropping the fields.
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const pi = createFakePi();
      extension(pi as any);
      registerAgent(
        pi,
        "reviewer.md",
        "name: reviewer\ndescription: digs\neffort: high\nmaxTurns: 5\nskills:\n  - code-review",
      );
      pi.flagValues.set("agent", "reviewer");

      await fire(pi);

      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain('"reviewer"');
      expect(out).toContain("thinking");
      expect(out).toContain("turnBudget");
      expect(out).toContain("skills");
      expect(out).toContain("not applied");
    } finally {
      spy.mockRestore();
    }
  });

  it("warns at most once per session for the same agent", async () => {
    // The warning is once-per-session so a multi-turn child does not spam. The
    // guard is closure-scoped to one factory call (one session).
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const pi = createFakePi();
      extension(pi as any);
      registerAgent(pi, "reviewer.md", "name: reviewer\ndescription: digs\neffort: high");
      pi.flagValues.set("agent", "reviewer");

      await fire(pi);
      await fire(pi);

      const writes = spy.mock.calls.filter((c) => String(c[0]).includes("reviewer"));
      expect(writes).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("does not warn when a resolved agent declares only applied fields", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const pi = createFakePi();
      extension(pi as any);
      registerAgent(pi, "reviewer.md", "name: reviewer\ndescription: digs", "You review code.");
      pi.flagValues.set("agent", "reviewer");

      await fire(pi);

      const out = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).not.toContain("reviewer");
    } finally {
      spy.mockRestore();
    }
  });
});


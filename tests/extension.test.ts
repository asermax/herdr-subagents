import { describe, it, expect, vi } from "vitest";
import { resolve, join } from "node:path";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// Seam 2 (spec Testing §Seam 2): the extension factory with a fake `pi`.
// We build a mock pi that captures event registrations, flags, and `pi.events`
// bus subscriptions, then invoke the captured handlers directly — the shape
// established by `@asermax/pi-cc-plugins`' `tests/extension.test.ts`.
//
// Covers the child-side onboarding injection and the agent-resolution role:
// the `--agent` flag, the registrar (precedence + field mapping +
// replace-per-(source,namespace)), and the `pi.events` presence handshake. The
// parent-side watcher registers into the same factory later.

import extension, { getHandle, PROVIDER_READY, PROVIDER_READY_REQUEST, REGISTER } from "../src/extension/index.js";

const ONBOARDING_PATH = resolve(import.meta.dirname, "..", "src", "shared", "onboarding.md");

/** Read the factory's in-process handle (registrar + provider-ready flag). */
function handle() {
  const h = getHandle();
  if (!h) throw new Error("extension handle not initialised");
  return h;
}

/** Write a Claude-format agent file under a fresh temp dir; return its path. */
function writeBusAgent(file: string, frontmatter: string): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-bus-agent-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, file);
  writeFileSync(path, `---\n${frontmatter}\n---\n`);
  return path;
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
  registerEntryRenderer: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
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
 * `runtime.flagValues` flow (research §1.1: argv is reconciled against
 * registered flags, and `getFlag` reads the result).
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
      // pi seeds the registered default at load (research §1.1).
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
    // The parent-side role calls these at registration time. They are
    // pipe-fitting (spec Testing §"Not covered") and are NOT asserted here —
    // the fake pi only needs to provide them so the factory composes.
    registerEntryRenderer: vi.fn(),
    appendEntry: vi.fn(),
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
});

describe("--agent flag", () => {
  // herdr launches a child as `herdr agent start --kind pi -- --agent <name>`;
  // the flag carries the agent name into the session. Same shape as pi's
  // `--fff-mode` (research §1.1): a string flag with no default, registered
  // declaratively so pi matches it against CLI argv — no process.argv parsing.
  it("registers the agent flag as a string flag at factory time", () => {
    const pi = createFakePi();
    extension(pi as any);

    expect(pi.registerFlag).toHaveBeenCalledWith("agent", { type: "string" });
  });

  it("has no default — an unset flag reads undefined, not a sentinel", () => {
    // research §1.1: `--fff-mode` registers `type: "string"` with no default,
    // resolved as flag → env → default. The agent flag follows the same shape.
    const pi = createFakePi();
    extension(pi as any);

    expect(pi.flags.get("agent")?.options.type).toBe("string");
    expect(pi.flags.get("agent")?.options.default).toBeUndefined();
    expect(pi.getFlag("agent")).toBeUndefined();
  });

  it("herdr's `-- --agent <name>` argv reaches pi.getFlag('agent')", () => {
    // Simulate pi's reconciliation: the `--agent reviewer` argv is reconciled
    // against the registered flag and lands in flagValues (research §1.1).
    // The extension reads it back through the same getFlag it registered.
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

describe("listener cleanup on shutdown", () => {
  it("cleans up the handshake's bus subscriptions on session_shutdown", async () => {
    // The factory subscribes to the presence-handshake channels; each
    // `pi.events.on` returns an unsubscribe fn pushed into the factory's drain
    // list. After shutdown the channels must be gone from the fake bus.
    const pi = createFakePi();
    extension(pi as any);

    // The provider subscribes to the consumer's request and to registrations.
    // (It does not subscribe to its own provider-ready signal.)
    const handshakeChannels = [
      PROVIDER_READY_REQUEST,
      REGISTER,
    ];
    for (const channel of handshakeChannels) {
      expect(pi.busHandlers.has(channel)).toBe(true);
    }

    const shutdown = pi.handlers.get("session_shutdown")!;
    await expect(shutdown({}, {})).resolves.toBeUndefined();

    for (const channel of handshakeChannels) {
      expect(pi.busHandlers.has(channel)).toBe(false);
    }

    // Idempotent: a second shutdown must not throw.
    await expect(shutdown({}, {})).resolves.toBeUndefined();
  });
});

describe("pi.events presence handshake", () => {
  // Eager emit-both-ways handshake (spec §8): both sides act at factory time,
  // where load order is not guaranteed, so each emits its own signal AND
  // listens for the other's. Whichever loads second triggers the first's
  // listener. The flag is correct by session start.

  /**
   * Model the consumer side (pi-cc-plugins): it subscribes to
   * provider-ready and emits provider-ready-request. When it sees
   * provider-ready it sets its own flag. Returns the flag so a test can assert
   * both sides converged regardless of load order.
   */
  function createConsumerSide(pi: FakePi): { consumerSawProvider: boolean } {
    let consumerSawProvider = false;
    pi.events.on(PROVIDER_READY, () => {
      const was = consumerSawProvider;
      consumerSawProvider = true;
      // Symmetric, idempotent re-emit (guarded to match the provider): a
      // provider that loaded before us already emitted ready and is waiting
      // for our request. Re-ask once so it learns we are present.
      if (!was) pi.events.emit(PROVIDER_READY_REQUEST, {});
    });
    pi.events.emit(PROVIDER_READY_REQUEST, {});
    return {
      get consumerSawProvider() {
        return consumerSawProvider;
      },
    };
  }

  it("emits provider-ready at factory time", () => {
    const pi = createFakePi();
    extension(pi as any);

    expect(pi.events.emit).toHaveBeenCalledWith(PROVIDER_READY, { version: 1 });
  });

  it("sets its flag when a consumer announces via provider-ready-request", () => {
    // The provider learns a consumer is present from its provider-ready-request.
    // Load order: herdr first, consumer second — the consumer's request trips
    // the listener herdr registered at factory time.
    const pi = createFakePi();
    extension(pi as any);
    const { herdrProviderReady } = handle();
    expect(herdrProviderReady()).toBe(false);

    pi.busHandlers.get(PROVIDER_READY_REQUEST)!({});

    expect(herdrProviderReady()).toBe(true);
  });

  it("re-emits provider-ready when a late consumer sends provider-ready-request", () => {
    // herdr loaded first; a consumer that loads later missed herdr's initial
    // provider-ready emit. The consumer emits provider-ready-request, which
    // makes herdr re-emit provider-ready so the consumer catches up.
    const pi = createFakePi();
    extension(pi as any);
    pi.events.emit.mockClear();

    pi.busHandlers.get(PROVIDER_READY_REQUEST)!({});

    expect(pi.events.emit).toHaveBeenCalledWith(PROVIDER_READY, { version: 1 });
  });

  it("does not ping-pong: a second request does not re-emit ready", () => {
    // Once the consumer is known present, further requests must not echo ready
    // again — otherwise the symmetric re-emit loops forever.
    const pi = createFakePi();
    extension(pi as any);
    pi.busHandlers.get(PROVIDER_READY_REQUEST)!({});
    pi.events.emit.mockClear();

    pi.busHandlers.get(PROVIDER_READY_REQUEST)!({});

    expect(pi.events.emit).not.toHaveBeenCalled();
  });

  it("converges in EITHER load order: herdr-first", () => {
    // herdr loads first: emits ready, registers a request listener.
    // consumer loads second: emits request (herdr's listener sets herdr's flag
    // and re-emits ready), and its ready listener catches herdr's ready.
    const pi = createFakePi();
    extension(pi as any);
    const { herdrProviderReady } = handle();
    const consumer = createConsumerSide(pi);

    expect(consumer.consumerSawProvider).toBe(true);
    expect(herdrProviderReady()).toBe(true);
  });

  it("converges in EITHER load order: consumer-first", () => {
    // Consumer loads first: emits provider-ready-request (no listener yet, so
    // lost) and registers a ready listener that re-asks once. herdr loads
    // second: emits ready (consumer sees it and re-asks), and herdr's request
    // listener catches the re-ask — so both flags converge.
    const pi = createFakePi();

    // Consumer side first.
    let consumerSawProvider = false;
    pi.events.on(PROVIDER_READY, () => {
      const was = consumerSawProvider;
      consumerSawProvider = true;
      if (!was) pi.events.emit(PROVIDER_READY_REQUEST, {});
    });
    pi.events.emit(PROVIDER_READY_REQUEST, {});

    // Now herdr loads.
    extension(pi as any);
    const { herdrProviderReady } = handle();

    expect(consumerSawProvider).toBe(true);
    expect(herdrProviderReady()).toBe(true);
  });
});

describe("pi.events:register — registrar wiring", () => {
  it("a register event feeds the registrar and the agent becomes resolvable", () => {
    const pi = createFakePi();
    extension(pi as any);
    const { registrar } = handle();

    expect(registrar.list()).toEqual([]);

    pi.busHandlers.get(REGISTER)!({
      version: 1,
      paths: [writeBusAgent("reviewer.md", "name: reviewer\ndescription: digs")],
      namespace: "my-plugin",
      source: "package",
    });

    expect(registrar.list()).toHaveLength(1);
    expect(registrar.list()[0]!.name).toBe("reviewer");
  });

  it("replaces per (source, namespace): a second emit for the same key drops the first set", () => {
    const pi = createFakePi();
    extension(pi as any);
    const { registrar } = handle();

    pi.busHandlers.get(REGISTER)!({
      version: 1,
      paths: [writeBusAgent("a.md", "name: alpha\ndescription: v1")],
      namespace: "",
      source: "project",
    });
    expect(registrar.list().map((a) => a.name)).toEqual(["alpha"]);

    pi.busHandlers.get(REGISTER)!({
      version: 1,
      paths: [writeBusAgent("b.md", "name: beta\ndescription: v2")],
      namespace: "",
      source: "project",
    });
    expect(registrar.list().map((a) => a.name)).toEqual(["beta"]); // no accumulation
  });

  it("different (source, namespace) keys accumulate", () => {
    const pi = createFakePi();
    extension(pi as any);
    const { registrar } = handle();

    pi.busHandlers.get(REGISTER)!({
      version: 1,
      paths: [writeBusAgent("a.md", "name: alpha\ndescription: p")],
      namespace: "",
      source: "project",
    });
    pi.busHandlers.get(REGISTER)!({
      version: 1,
      paths: [writeBusAgent("b.md", "name: beta\ndescription: pkg")],
      namespace: "plugin",
      source: "package",
    });

    expect(registrar.list().map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
  });
});


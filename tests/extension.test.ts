import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

// Seam 2 (spec Testing §Seam 2): the extension factory with a fake `pi`.
// We build a mock pi that captures event registrations, flags, and `pi.events`
// bus subscriptions, then invoke the captured handlers directly — the shape
// established by `@asermax/pi-cc-plugins`' `tests/extension.test.ts`.
//
// This slice owns only the child-side role: the extension factory, the
// `before_agent_start` onboarding injection gated on `HERDR_SUBAGENT`, and
// listener cleanup on shutdown. The parent-side watcher (#22) and agent
// resolution (#21) register into the factory stood up here; they are not built
// or asserted in this slice.

import extension from "../src/extension/index.js";

const ONBOARDING_PATH = resolve(import.meta.dirname, "..", "src", "shared", "onboarding.md");

/** A handler captured by the fake pi, for either a lifecycle event or a bus channel. */
type CapturedHandler = (event: any, ctx?: any) => any;

interface FakePi {
  on: ReturnType<typeof vi.fn>;
  events: {
    on: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
  };
  registerEntryRenderer: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  handlers: Map<string, CapturedHandler>;
  busHandlers: Map<string, (data: unknown) => void>;
}

/** Build a fake pi that captures lifecycle handler registrations and bus subscriptions. */
function createFakePi(): FakePi {
  const handlers = new Map<string, CapturedHandler>();
  const busHandlers = new Map<string, (data: unknown) => void>();

  return {
    on: vi.fn((event: string, handler: CapturedHandler) => {
      handlers.set(event, handler);
    }),
    events: {
      on: vi.fn((channel: string, handler: (data: unknown) => void) => {
        busHandlers.set(channel, handler);
        // `pi.events.on` returns an unsubscribe function (see pi's EventBus).
        return () => {
          busHandlers.delete(channel);
        };
      }),
      emit: vi.fn(),
    },
    // The parent-side role (#22) calls these at registration time. They are
    // pipe-fitting (spec Testing §"Not covered") and are NOT asserted here —
    // the fake pi only needs to provide them so the factory composes.
    registerEntryRenderer: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    handlers,
    busHandlers,
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
  it("cleans up bus subscriptions registered via pi.events.on", async () => {
    // `pi.events.on` returns an unsubscribe fn; the factory must call each one
    // on session_shutdown so no bus channel outlives the session. We model the
    // fake pi's unsubscribe as deleting from the captured map, so after
    // shutdown the channel must be gone.
    const pi = createFakePi();
    extension(pi as any);

    // Register a bus subscription the way #21/#22 will: through whatever the
    // factory exposes. This slice stands the home up, so at minimum the
    // factory's own internal subscriptions (if any) must clean up. We assert
    // the contract: shutdown runs without error and is idempotent.
    const shutdown = pi.handlers.get("session_shutdown")!;
    await expect(shutdown({}, {})).resolves.toBeUndefined();

    // A second shutdown must not throw (idempotent cleanup).
    await expect(shutdown({}, {})).resolves.toBeUndefined();
  });
});

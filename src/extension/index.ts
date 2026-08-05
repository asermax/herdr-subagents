import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import { createRegistrar, type Registrar, type RegisterPayload, type AgentRecord } from "./registrar.js";
import { registerParentRole } from "./parent-role.js";

// herdr-subagents pi extension. This slice owns the agent-resolution role
// — the `--agent` flag, the registrar that resolves
// `.claude/agents/*.md`, and the `pi.events` presence handshake. The child-side
// onboarding injection lives here too. No herdr socket client lives
// here — the helper is the only one.

const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Append `extra` to `base`, collapsing to `extra` when the base is empty. */
function appendPrompt(base: string, extra: string): string {
  return base.length === 0 ? extra : `${base}\n\n${extra}`;
}

const ONBOARDING = readOnboarding();

// Onboarding ships in two layouts: `../shared/` in the source repo, `../references/`
// in the built pi package (build/plan.ts). Try both rather than baking a path.
function readOnboarding(): string {
  const up = dirname(moduleDir);
  const candidates = [join(up, "shared", "onboarding.md"), join(up, "references", "onboarding.md")];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // try the next layout
    }
  }
  throw new Error(
    `herdr-subagents: could not find onboarding.md relative to ${moduleDir}. ` +
      `Expected one of: ${candidates.join(", ")}.`,
  );
}

// Bus channels, prefixed with the unscoped package name. The provider
// (this extension) and the consumer (`pi-cc-plugins`, separate repo) use these
// to find each other and to carry registrations.
const PKG = "pi-herdr-subagents";
export const PROVIDER_READY = `${PKG}:provider-ready`;
export const PROVIDER_READY_REQUEST = `${PKG}:provider-ready-request`;
export const REGISTER = `${PKG}:register`;

/** In-process handle for tests and sibling code; pi ignores it. */
export interface ExtensionHandle {
  registrar: Registrar;
  herdrProviderReady(): boolean;
}

// The most recently created handle. A pi process loads one extension factory per
// session, so this is single-instance in practice; tests and sibling code read it
// back to introspect bus state without reaching into the factory closure.
let currentHandle: ExtensionHandle | undefined;

/** Read back the handle for the active session. */
export function getHandle(): ExtensionHandle | undefined {
  return currentHandle;
}

export default function herdrSubagentsExtension(pi: ExtensionAPI): void {
  // Bus subscriptions return an unsubscribe fn (pi's EventBus); drained on
  // shutdown. Every `pi.events.on` in this factory pushes its unsub in here.
  const unsubs: Array<() => void> = [];

  // `--agent <name>` carries the child's agent name into the session. herdr
  // launches the child as `herdr agent start --kind pi -- --agent <name>`; the
  // flag is registered declaratively so pi matches it against CLI argv (research
  // §1.1). Same shape as pi's `--fff-mode`: a string flag with no default.
  pi.registerFlag("agent", { type: "string" });

  const registrar = createRegistrar();

  // Eager emit-both-ways presence handshake. Both sides act at
  // factory time, where load order is not guaranteed, so each emits its own
  // signal AND listens for the other's; whichever loads second triggers the
  // first's listener. The flag is correct by session start.
  //
  // SELF-EMIT TRAP — why the provider emits ONLY its own signal. pi's EventBus
  // is a Node EventEmitter (dist/core/event-bus.js), so a self-emit is delivered
  // to the emitter's own listeners. If the provider emitted the consumer's
  // signal (`provider-ready-request`), its own request listener would fire at
  // once and falsely mark the consumer present. So each side emits only the
  // signal it OWNS and listens only for the one it does not:
  //   - PROVIDER (this extension): emits `provider-ready`; listens for
  //     `provider-ready-request`. On a request it sets its presence flag and
  //     re-emits `provider-ready` once.
  //   - CONSUMER (`pi-cc-plugins`): emits `provider-ready-request`;
  //     listens for `provider-ready`. On seeing ready it sets its own flag and
  //     re-emits its request once — this symmetric re-emit is REQUIRED, or a
  //     provider that loaded first never learns the consumer exists.
  // The one-shot re-emit is guarded so the two sides cannot ping-pong.
  let consumerPresent = false;

  // Register listeners BEFORE emitting: a consumer's synchronous re-emit (on
  // seeing our ready) must find this listener already installed, or its reply
  // is lost.
  unsubs.push(
    pi.events.on(PROVIDER_READY_REQUEST, () => {
      const wasPresent = consumerPresent;
      consumerPresent = true;
      if (!wasPresent) pi.events.emit(PROVIDER_READY, { version: 1 });
    }),
  );

  // Announce ourselves. A consumer that loaded before us missed this; it asks
  // us to repeat it (provider-ready-request), and the listener above re-emits.
  pi.events.emit(PROVIDER_READY, { version: 1 });

  // Registrations arrive over the bus from pi-cc-plugins (or any other
  // provider). Each one REPLACES per (source, namespace) rather than
  // accumulating, so a session switch drops the previous project's agents with
  // no staleness. Fire-and-forget: no acknowledgement.
  unsubs.push(
    pi.events.on(REGISTER, (data) => {
      const payload = data as RegisterPayload;
      if (!payload || typeof payload !== "object") return;
      registrar.register(payload);
    }),
  );

  // Spawn-time fields on an AgentRecord that this extension cannot apply from
  // before_agent_start — they need upstream pi support.
  // Warned once per session per agent so the limit surfaces honestly instead of
  // being silently dropped. Closure-scoped: one factory call = one session.
  const warnedUnapplied = new Set<string>();

  function warnUnappliedFields(agent: AgentRecord): void {
    const unapplied: string[] = [];
    if (agent.thinking) unapplied.push("thinking");
    if (agent.turnBudget) unapplied.push("turnBudget");
    if (agent.skills && agent.skills.length > 0) unapplied.push("skills");
    if (unapplied.length === 0) return;

    const key = `${agent.name}@${unapplied.join(",")}`;
    if (warnedUnapplied.has(key)) return;
    warnedUnapplied.add(key);
    process.stderr.write(
      `herdr-subagents: agent "${agent.name}" declares ${unapplied.join("/")}; ` +
        `these are not applied on pi (spawn-time fields, need upstream pi support — spec §Out of Scope)\n`,
    );
  }

  pi.on("before_agent_start", async (event) => {
    let systemPrompt: string | undefined;

    // Onboarding: injected only for herdr-launched children, gated
    // by HERDR_SUBAGENT presence. Absent → a normal session pays nothing.
    if (process.env.HERDR_SUBAGENT != null) {
      systemPrompt = appendPrompt(event.systemPrompt, ONBOARDING);
    }

    // Agent-definition consumption: apply the resolved agent's
    // system prompt. Runs independently of onboarding — a
    // child can be launched with `--agent` but without HERDR_SUBAGENT. The
    // `--agent` flag is registered declaratively above (research §1.1).
    const agentName = pi.getFlag("agent");
    if (typeof agentName === "string" && agentName.length > 0) {
      const agent = registrar.resolve(agentName);
      if (agent) {
        warnUnappliedFields(agent);
        // Onboarding first (general herdr-child framing), then the agent's
        // role prompt — most specific last so it is the most prominent.
        if (agent.systemPrompt) {
          systemPrompt = appendPrompt(systemPrompt ?? event.systemPrompt, agent.systemPrompt);
        }
      }
    }

    if (systemPrompt === undefined) return;
    const result: BeforeAgentStartEventResult = { systemPrompt };
    return result;
  });

  pi.on("session_shutdown", async () => {
    while (unsubs.length > 0) {
      const unsub = unsubs.pop();
      if (!unsub) continue;
      try {
        unsub();
      } catch {
        // A failing unsubscribe must not abort cleanup of the rest.
      }
    }
  });

  const handle: ExtensionHandle = {
    registrar,
    herdrProviderReady: () => consumerPresent,
  };
  currentHandle = handle;

  // Parent-side role: spawn `helper watch`, forward changes into
  // TUI-only status cards, and wake on terminal-only states. Pushes its
  // teardown into the drain list so session_shutdown stops the watcher.
  unsubs.push(registerParentRole(pi));
}

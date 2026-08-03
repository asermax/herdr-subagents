import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRegistrar, type Registrar, type RegisterPayload } from "./registrar.js";

// herdr-subagents pi extension. This slice owns the agent-resolution role
// (spec §7/§8): the `--agent` flag, the registrar that resolves
// `.claude/agents/*.md`, and the `pi.events` presence handshake. The child-side
// onboarding injection (spec §6) lives here too. No herdr socket client lives
// here — the helper is the only one (spec §3).

const here = dirname(fileURLToPath(import.meta.url));

const ONBOARDING = readOnboarding();

// Onboarding ships in two layouts: `../shared/` in the source repo, `../skills/`
// in the built pi package (build/plan.ts). Try both rather than baking a path.
function readOnboarding(): string {
  const up = dirname(here);
  const candidates = [join(up, "shared", "onboarding.md"), join(up, "skills", "onboarding.md")];
  for (const path of candidates) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // try the next layout
    }
  }
  throw new Error(
    `herdr-subagents: could not find onboarding.md relative to ${here}. ` +
      `Expected one of: ${candidates.join(", ")}.`,
  );
}

// Bus channels (spec §8), prefixed with the unscoped package name. The provider
// (this extension) and the consumer (`pi-cc-plugins`, separate repo) use these
// to find each other and to carry registrations.
const PKG = "pi-herdr-subagents";
export const PROVIDER_READY = `${PKG}:provider-ready`;
export const PROVIDER_READY_REQUEST = `${PKG}:provider-ready-request`;
export const REGISTER = `${PKG}:register`;

/** In-process handle for tests and sibling code (#22); pi ignores it. */
export interface ExtensionHandle {
  registrar: Registrar;
  /** True once a consumer announced presence on the bus. */
  herdrProviderReady(): boolean;
}

// The most recently created handle. A pi process loads one extension factory per
// session, so this is single-instance in practice; tests and sibling code read it
// back to introspect bus state without reaching into the factory closure.
let currentHandle: ExtensionHandle | undefined;

/** Read back the handle for the active session (tests, #22). */
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

  // Eager emit-both-ways presence handshake (spec §8). Both sides act at
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
  //   - CONSUMER (`pi-cc-plugins`, ticket #23): emits `provider-ready-request`;
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
  // no staleness. Fire-and-forget: no acknowledgement (spec §8).
  unsubs.push(
    pi.events.on(REGISTER, (data) => {
      const payload = data as RegisterPayload;
      if (!payload || typeof payload !== "object") return;
      registrar.register(payload);
    }),
  );

  pi.on("before_agent_start", async (event) => {
    // The gate is implementation-only (CONTEXT.md): presence means "this
    // session is a child". Absent → a normal session pays nothing.
    if (process.env.HERDR_SUBAGENT == null) return;

    // Append, do not replace (spec §6/§7): pi's operational prompt layer must
    // survive — context and system-prompt are the same layer of authority.
    const base = event.systemPrompt;
    const systemPrompt = base.length === 0 ? ONBOARDING : `${base}\n\n${ONBOARDING}`;

    return { systemPrompt };
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
}

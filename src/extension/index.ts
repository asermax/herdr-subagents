import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerParentRole } from "./parent-role.js";

// Child-side role of the herdr-subagents pi extension. Owns onboarding
// injection only (spec §6); stands up the factory #21/#22 extend. No herdr
// socket client lives here (the helper is the only one — spec §3).

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

export default function herdrSubagentsExtension(pi: ExtensionAPI): void {
  // Bus subscriptions return an unsubscribe fn (pi's EventBus); drained on
  // shutdown. #21 and #22 push their unsubs in here when they register.
  const unsubs: Array<() => void> = [];

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

  // Parent-side role (#22): spawn `helper watch`, forward changes into
  // TUI-only status cards, and wake on terminal-only states. Pushes its
  // teardown into the drain list so session_shutdown stops the watcher.
  unsubs.push(registerParentRole(pi));
}

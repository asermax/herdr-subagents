import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import { resolveAgents, resolveAgentByName, type AgentRecord } from "./registrar.js";
import { helperPath, registerParentRole } from "./parent-role.js";

// herdr-subagents pi extension. This slice owns agent-resolution — reading
// `.pi/agents/` and `.claude/agents/` directly (no event bus, no coupling to
// pi-cc-plugins) — plus the child-side onboarding injection. The parent-side
// status widget + terminal-state wake lives in parent-role.ts. No herdr
// socket client lives here — the helper is the only one.

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

// The cwd used to resolve agent definitions. Defaults to process.cwd() (the
// project root pi runs from). pi-cc-plugins writes agents into `.pi/agents/`
// during session_start; before_agent_start fires later, so the files are
// guaranteed present. Overridable for tests via _setResolveCwd.
let resolveCwd = process.cwd();

/** Test-only: override the cwd for agent resolution. */
export function _setResolveCwd(dir: string): void {
  resolveCwd = dir;
}

export default function herdrSubagentsExtension(pi: ExtensionAPI): void {
  // Publish the helper's resolved path into the environment so the agent's
  // bash — the delegate skill runs `${HERDR_SUBAGENT_HELPER:-herdr-helper}` —
  // finds the helper on any install, not just the host that built the skill.
  // Respect an explicit override (the dev loop sets it before launching pi).
  if (process.env.HERDR_SUBAGENT_HELPER === undefined) {
    process.env.HERDR_SUBAGENT_HELPER = helperPath();
  }

  // Lifecycle subscriptions return an unsubscribe fn, drained on shutdown.
  const unsubs: Array<() => void> = [];

  // `--agent <name>` carries the child's agent name into the session. herdr
  // launches the child as `herdr agent start --kind pi -- --agent <name>`; the
  // flag is registered declaratively so pi matches it against CLI argv.
  pi.registerFlag("agent", { type: "string" });

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
        `these are not applied on pi (spawn-time fields, need upstream pi support)\n`,
    );
  }

  pi.on("before_agent_start", async (event) => {
    let systemPrompt: string | undefined;

    // Onboarding: injected only for herdr-launched children, gated
    // by HERDR_SUBAGENT presence. Absent → a normal session pays nothing.
    if (process.env.HERDR_SUBAGENT != null) {
      systemPrompt = appendPrompt(event.systemPrompt, ONBOARDING);
    }

    // Agent-definition consumption: resolve agents from `.pi/agents/` +
    // `.claude/agents/` on disk and apply the matched agent's system prompt.
    // Runs independently of onboarding — a child can be launched with
    // `--agent` but without HERDR_SUBAGENT. The `--agent` flag is registered
    // declaratively above.
    const agentName = pi.getFlag("agent");
    if (typeof agentName === "string" && agentName.length > 0) {
      const { agents } = resolveAgents({ cwd: resolveCwd });
      const agent = resolveAgentByName(agents, agentName);
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

  // Parent-side role: spawn `helper watch`, summarize tracked children into
  // one status widget above the input, and wake on terminal-only states. Pushes its
  // teardown into the drain list so session_shutdown stops the watcher.
  unsubs.push(registerParentRole(pi));
}

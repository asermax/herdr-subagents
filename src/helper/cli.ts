#!/usr/bin/env node
// The helper — the complete interface to delegation, invoked over bash. The
// only herdr socket client in the system. The pi extension does NOT get one.

import { collectChild, waitChild, type CollectDeps } from "./collect.js";
import { clientFromEnv, currentWorkspaceId } from "./herdr-client.js";
import { HerdrError } from "./herdr-types.js";
import { fileRegistryStore, Registry } from "./registry.js";
import { isSpawnFailure, spawnChild, type SpawnResult } from "./spawn.js";
import { runWatch } from "./watch.js";

const KINDS = ["pi", "claude"] as const;
type Kind = (typeof KINDS)[number];

function isKind(v: string): v is Kind {
  return (KINDS as readonly string[]).includes(v);
}

export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith("--")) continue;
    // A bare `--` is the conventional separator, not a flag. Skip it without
    // treating the following token as its value.
    if (a === "--") continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    // Value-bearing flags consume the next token unconditionally — even when
    // it starts with `--` (e.g. --label "--refactor"). Without this, a
    // `--`-prefixed value is silently dropped and the flag reads as `true`.
    if (VALUE_FLAGS.has(key) && next !== undefined) {
      out[key] = next;
      i++;
    } else if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

// Flags that take a value (vs. bare boolean flags). A value-bearing flag
// consumes the next token as its value regardless of a leading `--`, so a
// label or body like "--refactor" is preserved instead of eaten.
const VALUE_FLAGS = new Set(["kind", "agent", "label", "body", "cwd", "workspace", "timeout"]);

// Flags `spawn` claims for itself. Anything else on the parent's argv forwards
// to the child's harness (a parent under development passes the same
// flags to its children; production passes nothing). Not an allowlist — the
// complement of our own surface, so future flags forward by default.
const SPAWN_OWN_FLAGS = new Set(["kind", "agent", "label", "body", "cwd", "workspace"]);

/**
 * Extract the argv slice to forward to a spawned child: every `--flag value`
 * pair after the `spawn` subcommand that `spawn` does not consume itself.
 * Re-emits them in their original `--flag value` / `--flag` form.
 */
function passthroughArgs(argv: string[]): string[] {
  // Drop the subcommand (argv[0] after slice(2)).
  const rest = argv.slice(3);
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === undefined || !a.startsWith("--")) continue;
    const key = a.slice(2);
    if (SPAWN_OWN_FLAGS.has(key)) {
      // Skip the value too if it is a non-flag token.
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
      continue;
    }
    out.push(a);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.push(next);
      i++;
    }
  }
  return out;
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function buildDeps() {
  const client = clientFromEnv();
  const probe = (paneId: string) => client.agentGet(paneId);
  const registry = new Registry(fileRegistryStore(), probe);
  return { client, registry };
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);

  switch (subcommand) {
    case "spawn":
      return runSpawn(flags);
    case "prompt":
      return runPrompt(flags);
    case "wait":
      return runWait(flags);
    case "collect":
      return runCollect();
    case "list":
      return runList();
    case "close":
      return runClose();
    case "watch":
      return runWatch();
    default:
      fail(
        `unknown subcommand ${subcommand ?? "(none)"}\n` +
          "usage: helper <spawn|prompt|wait|collect|list|close|watch> [options]",
        2,
      );
  }
}

async function runSpawn(flags: Record<string, string>): Promise<void> {
  // --kind is required and restricted to exactly pi|claude. Anything else is
  // rejected BEFORE reaching herdr.
  const kind = flags.kind;
  if (!kind) fail("--kind is required (pi|claude)", 2);
  if (!isKind(kind)) fail(`--kind must be one of ${KINDS.join("|")}, got ${kind}`, 2);

  const agentName = flags.agent;
  if (!agentName) fail("--agent is required (a name, not a path)", 2);
  // --agent takes a name, never a path.
  if (agentName.includes("/")) fail(`--agent must be a name, not a path: ${agentName}`, 2);

  const label = flags.label;
  if (!label) fail("--label is required", 2);

  const body = flags.body ?? "";
  const cwd = flags.cwd ?? process.cwd();
  const workspaceId = flags.workspace ?? currentWorkspaceId();

  const { client, registry } = buildDeps();
  try {
    const result: SpawnResult = await spawnChild(
      { kind, agentName, label, cwd, workspaceId, body, passThroughArgs: passthroughArgs(process.argv) },
      { client },
    );
    await registry.add({
      pane_id: result.pane_id,
      tab_id: result.tab_id,
      workspace_id: workspaceId,
      label,
      agent: agentName,
      kind,
      agent_name: agentName,
      status: "idle",
    });
    emit(result);
  } catch (e) {
    emit(e);
    fail(
      isSpawnFailure(e)
        ? `spawn failed: ${e.message}`
        : `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

async function runPrompt(flags: Record<string, string>): Promise<void> {
  const paneId = restPositional(process.argv.slice(2));
  if (!paneId) fail("usage: helper prompt <pane_id> --body <text>", 2);
  const body = flags.body;
  if (body === undefined) fail("--body is required", 2);
  const { client } = buildDeps();
  // The body arrives already wrapped in <supervisor-agent> by the caller.
  await client.agentPrompt(paneId, body);
  emit({ pane_id: paneId, sent: true });
}

async function runWait(flags: Record<string, string>): Promise<void> {
  const paneId = restPositional(process.argv.slice(2));
  if (!paneId) fail("usage: helper wait <pane_id>", 2);
  const { client } = buildDeps();
  const timeout = flags.timeout ? Number(flags.timeout) : 0;
  // wait returns on terminal state (done|gone), NOT on blocked.
  const snap = await waitChild(paneId, client, timeout);
  emit({ pane_id: paneId, status: snap.agent_status });
}

async function runCollect(): Promise<void> {
  const paneId = restPositional(process.argv.slice(2));
  if (!paneId) fail("usage: helper collect <pane_id>", 2);
  const { client, registry } = buildDeps();
  const deps: CollectDeps = { client, registry };
  emit(await collectChild(paneId, deps));
}

async function runList(): Promise<void> {
  const { registry } = buildDeps();
  const children = await registry.list();
  emit({ children });
}

async function runClose(): Promise<void> {
  const tabId = restPositional(process.argv.slice(2));
  if (!tabId) fail("usage: helper close <tab_id>", 2);
  const { client, registry } = buildDeps();
  await client.tabClose(tabId);
  // Drop any tracked child whose tab we just closed.
  for (const child of await registry.list()) {
    if (child.tab_id === tabId) await registry.remove(child.pane_id);
  }
  emit({ tab_id: tabId, closed: true });
}

// The positional argument is the first non-flag token after the subcommand.
// Callers pass process.argv.slice(2), so argv[0] is already the subcommand;
// parseArgs consumes flag values, so recover the positional from argv directly.
function restPositional(argv: string[]): string | undefined {
  const rest = argv.filter((a) => !a.startsWith("--"));
  // The first positional is the subcommand; the second is our argument.
  return rest[1];
}

// Run only when invoked as the entrypoint — importing the module (for unit
// tests of parseArgs) must not trigger the CLI.
if (import.meta.main) {
  main().catch((e) => {
    if (e instanceof HerdrError) fail(e.message);
    fail(e instanceof Error ? e.message : String(e));
  });
}

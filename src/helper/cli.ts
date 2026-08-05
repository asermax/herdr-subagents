#!/usr/bin/env node
// The helper — the complete interface to delegation, invoked over bash. The
// only herdr socket client in the system. The pi extension does NOT get one.

import { defineCommand, runMain } from "citty";
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

// Flags `spawn` claims for itself. Anything else on the parent's argv forwards
// to the child's harness (a parent under development passes the same flags to
// its children; production passes nothing). Not an allowlist — the complement
// of our own surface, so future flags forward by default.
const SPAWN_OWN_FLAGS = new Set(["kind", "agent", "label", "body", "cwd", "workspace"]);

const SUBCOMMANDS = new Set(["spawn", "prompt", "wait", "collect", "list", "close", "watch"]);
const USAGE = "usage: helper <spawn|prompt|wait|collect|list|close|watch> [options]";

/**
 * Extract the argv slice to forward to a spawned child: every `--flag value`
 * pair from the spawn subcommand's rawArgs that spawn does not consume itself.
 * Re-emits them in their original `--flag value` / `--flag` form. A bare `--`
 * separator is skipped without consuming the next token.
 *
 * Scans the subcommand's `rawArgs` (already post-subcommand) — NOT citty's
 * parsed args. citty cannot round-trip an unknown `--flag value` pair: the
 * flag reads as `true` and the value detaches into `args._`. rawArgs keeps the
 * exact tokens and pairing, so passthrough is built from it.
 */
export function passthroughArgs(rawArgs: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === undefined || !a.startsWith("--")) continue;
    if (a === "--") continue;
    const key = a.slice(2);
    if (SPAWN_OWN_FLAGS.has(key)) {
      // Skip the value too if it is a non-flag token.
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
      continue;
    }
    out.push(a);
    const next = rawArgs[i + 1];
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

// Surface a thrown error as a single-line stderr message, matching the
// original top-level catch. citty's runMain dumps the full error object;
// validation paths call fail() directly and never reach here.
async function runCatching(p: Promise<void>): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HerdrError) fail(e.message);
    fail(e instanceof Error ? e.message : String(e));
  }
}

// --- subcommand bodies --------------------------------------------------

interface SpawnArgs {
  kind: string | undefined;
  agent: string | undefined;
  label: string | undefined;
  body: string;
  cwd: string;
  workspace: string | undefined;
}

async function runSpawn(args: SpawnArgs, rawArgs: string[]): Promise<void> {
  // --kind is required and restricted to exactly pi|claude. Anything else is
  // rejected BEFORE reaching herdr.
  const kind = args.kind;
  if (!kind) fail("--kind is required (pi|claude)", 2);
  if (!isKind(kind)) fail(`--kind must be one of ${KINDS.join("|")}, got ${kind}`, 2);

  const agentName = args.agent;
  // --agent is optional: omit it to dispatch a generic child running the
  // harness default agent. When provided it takes a name, never a path.
  if (agentName !== undefined && agentName.includes("/")) {
    fail(`--agent must be a name, not a path: ${agentName}`, 2);
  }

  const label = args.label;
  if (!label) fail("--label is required", 2);

  const body = args.body;
  const cwd = args.cwd;
  const workspaceId = args.workspace ?? currentWorkspaceId();

  const { client, registry } = buildDeps();
  try {
    const result: SpawnResult = await spawnChild(
      { kind, agentName, label, cwd, workspaceId, body, passThroughArgs: passthroughArgs(rawArgs) },
      { client },
    );
    await registry.add({
      pane_id: result.pane_id,
      tab_id: result.tab_id,
      workspace_id: workspaceId,
      label,
      agent: agentName ?? label,
      kind,
      agent_name: agentName ?? label,
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

interface PromptArgs {
  paneId: string | undefined;
  body: string | undefined;
}

async function runPrompt(args: PromptArgs): Promise<void> {
  const paneId = args.paneId;
  if (!paneId) fail("usage: helper prompt <pane_id> --body <text>", 2);
  const body = args.body;
  if (body === undefined) fail("--body is required", 2);
  const { client } = buildDeps();
  // The body arrives already wrapped in <supervisor-agent> by the caller.
  await client.agentPrompt(paneId, body);
  emit({ pane_id: paneId, sent: true });
}

interface WaitArgs {
  paneId: string | undefined;
  timeout: string | undefined;
}

async function runWait(args: WaitArgs): Promise<void> {
  const paneId = args.paneId;
  if (!paneId) fail("usage: helper wait <pane_id>", 2);
  const { client } = buildDeps();
  const timeout = args.timeout ? Number(args.timeout) : 0;
  // wait returns on terminal state (done|gone), NOT on blocked.
  const snap = await waitChild(paneId, client, timeout);
  emit({ pane_id: paneId, status: snap.agent_status });
}

interface CollectArgs {
  paneId: string | undefined;
}

async function runCollect(args: CollectArgs): Promise<void> {
  const paneId = args.paneId;
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

interface CloseArgs {
  tabId: string | undefined;
}

async function runClose(args: CloseArgs): Promise<void> {
  const tabId = args.tabId;
  if (!tabId) fail("usage: helper close <tab_id>", 2);
  const { client, registry } = buildDeps();
  await client.tabClose(tabId);
  // Drop any tracked child whose tab we just closed.
  for (const child of await registry.list()) {
    if (child.tab_id === tabId) await registry.remove(child.pane_id);
  }
  emit({ tab_id: tabId, closed: true });
}

// --- commands -----------------------------------------------------------

const spawn = defineCommand({
  args: {
    kind: { type: "string", description: "Harness kind (pi|claude)" },
    agent: { type: "string", description: "Agent name (not a path)" },
    label: { type: "string", description: "Tab label" },
    body: { type: "string", default: "", description: "Task prompt body" },
    cwd: { type: "string", default: process.cwd(), description: "Child working directory" },
    workspace: { type: "string", description: "Workspace id" },
  },
  run: ({ args, rawArgs }) => runCatching(runSpawn(args, rawArgs)),
});

const prompt = defineCommand({
  args: {
    // required:false so a missing id reaches our own usage guard (exact
    // message + exit 2) instead of citty's default error.
    paneId: { type: "positional", required: false, description: "Pane id" },
    body: { type: "string", description: "Prompt body" },
  },
  run: ({ args }) => runCatching(runPrompt(args)),
});

const wait = defineCommand({
  args: {
    paneId: { type: "positional", required: false, description: "Pane id" },
    timeout: { type: "string", description: "Timeout in ms" },
  },
  run: ({ args }) => runCatching(runWait(args)),
});

const collect = defineCommand({
  args: {
    paneId: { type: "positional", required: false, description: "Pane id" },
  },
  run: ({ args }) => runCatching(runCollect(args)),
});

const list = defineCommand({
  args: {},
  run: () => runCatching(runList()),
});

const close = defineCommand({
  args: {
    tabId: { type: "positional", required: false, description: "Tab id" },
  },
  run: ({ args }) => runCatching(runClose(args)),
});

const watch = defineCommand({
  args: {},
  run: () => runCatching(runWatch()),
});

const main = defineCommand({
  subCommands: { spawn, prompt, wait, collect, list, close, watch },
});

// Run only when invoked as the entrypoint — importing the module (for unit
// tests of passthroughArgs) must not trigger the CLI. The subcommand token is
// validated here so the none/unknown cases keep the exact usage message and
// exit code 2; runMain then dispatches the known subcommand.
if (import.meta.main) {
  const token = process.argv.slice(2)[0];
  if (!SUBCOMMANDS.has(token ?? "")) {
    fail(`unknown subcommand ${token ?? "(none)"}\n${USAGE}`, 2);
  }
  runMain(main);
}

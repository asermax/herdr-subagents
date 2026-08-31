import { spawn } from "node:child_process";
import { Type, type Static } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { helperPath } from "./parent-role.js";

// The `subagent` tool — one LLM-callable tool that wraps the full helper
// surface. On pi this replaces bash invocations of `herdr-helper`: the model
// calls this structured tool instead of constructing shell commands. The tool
// builds the helper argv, spawns the binary by absolute path (helperPath),
// and returns its JSON output. `watch` is excluded — the extension already
// runs `helper watch` via parent-role.ts.

const COMMANDS = [
  "spawn",
  "prompt",
  "wait",
  "collect",
  "list",
  "close",
  "read",
  "unblock",
] as const;
export type SubagentCommand = (typeof COMMANDS)[number];

/** Flat options shared across all commands; only the relevant subset is used per command. */
export interface SubagentOptions {
  kind?: string;
  agent?: string;
  label?: string;
  worktree?: boolean;
  branch?: string;
  base?: string;
  pane_id?: string;
  tab_id?: string;
  body?: string;
  timeout?: number;
  keys?: string;
  lines?: number;
}

const subagentSchema = Type.Object({
  command: Type.Union([
    Type.Literal("spawn"),
    Type.Literal("prompt"),
    Type.Literal("wait"),
    Type.Literal("collect"),
    Type.Literal("list"),
    Type.Literal("close"),
    Type.Literal("read"),
    Type.Literal("unblock"),
  ]),
  options: Type.Object({
    kind: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("claude")])),
    agent: Type.Optional(Type.String({ description: "Agent name (not a path)" })),
    label: Type.Optional(Type.String({ description: "Tab label" })),
    worktree: Type.Optional(
      Type.Boolean({ description: "Give the child its own git worktree (spawn only)" }),
    ),
    branch: Type.Optional(
      Type.String({ description: "Worktree branch; an existing one is joined (spawn only)" }),
    ),
    base: Type.Optional(
      Type.String({ description: "Ref a new worktree branch forks from (spawn only)" }),
    ),
    pane_id: Type.Optional(Type.String({ description: "Pane id" })),
    tab_id: Type.Optional(Type.String({ description: "Tab id" })),
    body: Type.Optional(Type.String({ description: "Prompt body (wrap in <supervisor-agent>)" })),
    timeout: Type.Optional(Type.Number({ description: "Timeout in ms (wait only)" })),
    keys: Type.Optional(
      Type.String({ description: 'Space-separated key names, e.g. "1 enter" (unblock only)' }),
    ),
    lines: Type.Optional(Type.Number({ description: "Screen lines to read (read only)" })),
  }),
});

export type SubagentParams = Static<typeof subagentSchema>;

export interface SubagentToolDetails {
  command: SubagentCommand;
  exitCode: number;
}

/**
 * Map `{ command, options }` to the helper CLI argv slice (post-subcommand
 * token). Pure — no I/O — so it is unit-tested directly. Mirrors the helper's
 * own flag/positional conventions (cli.ts):
 *
 * | command  | argv                                                    |
 * | -------- | ------------------------------------------------------- |
 * | spawn    | `spawn --kind <kind> --label <label> [--agent <agent>] [--worktree [--branch <b>] [--base <r>]]` |
 * | prompt   | `prompt <pane_id> --body <body>`                        |
 * | wait     | `wait <pane_id> [--timeout <ms>]`                       |
 * | collect  | `collect <pane_id>`                                     |
 * | list     | `list`                                                  |
 * | close    | `close <tab_id>`                                        |
 * | read     | `read <pane_id> [--lines <n>]`                          |
 * | unblock  | `unblock <pane_id> --keys <keys>`                       |
 */
export function buildHelperArgs(command: SubagentCommand, options: SubagentOptions): string[] {
  switch (command) {
    case "spawn": {
      const args = ["spawn"];
      if (options.kind) args.push("--kind", options.kind);
      if (options.agent) args.push("--agent", options.agent);
      if (options.label) args.push("--label", options.label);
      if (options.worktree) {
        args.push("--worktree");
        if (options.branch) args.push("--branch", options.branch);
        if (options.base) args.push("--base", options.base);
      }
      return args;
    }
    case "prompt": {
      const args = ["prompt"];
      if (options.pane_id) args.push(options.pane_id);
      if (options.body) args.push("--body", options.body);
      return args;
    }
    case "wait": {
      const args = ["wait"];
      if (options.pane_id) args.push(options.pane_id);
      if (options.timeout !== undefined) args.push("--timeout", String(options.timeout));
      return args;
    }
    case "collect": {
      const args = ["collect"];
      if (options.pane_id) args.push(options.pane_id);
      return args;
    }
    case "list":
      return ["list"];
    case "close": {
      const args = ["close"];
      if (options.tab_id) args.push(options.tab_id);
      return args;
    }
    case "read": {
      const args = ["read"];
      if (options.pane_id) args.push(options.pane_id);
      if (options.lines !== undefined) args.push("--lines", String(options.lines));
      return args;
    }
    case "unblock": {
      const args = ["unblock"];
      if (options.pane_id) args.push(options.pane_id);
      if (options.keys) args.push("--keys", options.keys);
      return args;
    }
  }
}

// --- result formatting -------------------------------------------------
//
// The tool returns descriptive text, not raw JSON, so the harness display
// reads as a clear line per command. The helper's structured fields are
// embedded in the text; the model parses them from the message.

interface CollectResultJson {
  pane_id: string;
  label: string;
  agent: string;
  status: string;
  message?: string;
  ask?: boolean;
  error?: string;
}

interface ListChildJson {
  pane_id: string;
  label: string;
  status: string;
}

interface ListResultJson {
  children: ListChildJson[];
}

interface ReadResultJson {
  status: string;
  screen: string;
}

interface UnblockResultJson {
  status: string;
  cleared: boolean;
  screen?: string;
}

/** A short label for a child, preferring the human-readable name. */
function childName(...candidates: (string | undefined)[]): string {
  return candidates.find((c) => c && c.length > 0) ?? "subagent";
}

/** Strip the <supervisor-agent> wrapper tags from a prompt body. */
function stripSupervisorTag(body: string): string {
  return body
    .replace(/^<supervisor-agent>\s*/, "")
    .replace(/\s*<\/supervisor-agent>\s*$/, "");
}

/**
 * Look up a child's label from the registry via `helper list`. Used by
 * commands whose own result carries no label (prompt, wait, close). Must be
 * called BEFORE close — close removes the registry entry.
 */
async function resolveLabel(options: SubagentOptions): Promise<string | undefined> {
  const output = await runHelper(helperPath(), ["list"], undefined);
  if (!output.json) return undefined;
  const result = output.json as {
    children: Array<{ pane_id: string; tab_id: string; label: string }>;
  };
  for (const child of result.children) {
    if (options.pane_id && child.pane_id === options.pane_id) return child.label;
    if (options.tab_id && child.tab_id === options.tab_id) return child.label;
  }
  return undefined;
}

/**
 * Format the helper's JSON output as a descriptive one-liner (or short block)
 * for each command. Pure — no I/O — so it is unit-tested directly.
 */
export function formatResult(
  command: SubagentCommand,
  options: SubagentOptions,
  json: unknown,
): string {
  switch (command) {
    case "spawn": {
      const name = childName(options.label, options.agent);
      return `Started subagent ${name}`;
    }
    case "prompt": {
      const name = childName(options.label);
      const body = stripSupervisorTag(options.body ?? "");
      return `Sent prompt to subagent ${name}:\n${body}`;
    }
    case "wait": {
      const name = childName(options.label);
      return `Waited for subagent ${name}`;
    }
    case "collect": {
      const r = json as CollectResultJson;
      const name = childName(r.label, r.agent, options.label);
      if (r.error) return `Subagent ${name} errored: ${r.error}`;
      if (r.ask) return `Subagent ${name} is asking:\n${r.message ?? ""}`;
      if (r.message) return `Subagent ${name}:\n${r.message}`;
      return `Subagent ${name} has no message yet`;
    }
    case "list": {
      const r = json as ListResultJson;
      if (!r.children || r.children.length === 0) return "No children tracked.";
      const lines = r.children.map((c) => `  ${c.label || c.pane_id}`);
      return `Fleet (${r.children.length}):\n${lines.join("\n")}`;
    }
    case "close": {
      const name = childName(options.label);
      return `Closed subagent ${name}`;
    }
    case "read": {
      const r = json as ReadResultJson;
      const name = childName(options.label);
      return `Subagent ${name} is ${r.status}. Its pane:\n${r.screen}`;
    }
    case "unblock": {
      const r = json as UnblockResultJson;
      const name = childName(options.label);
      if (r.cleared) return `Unblocked subagent ${name}; it is now ${r.status}`;
      return `Subagent ${name} is still blocked after ${options.keys ?? "the keys"}. Its pane:\n${
        r.screen ?? ""
      }`;
    }
  }
}

/**
 * Format a helper failure as a descriptive error message. `json` is the
 * structured error the helper may emit before exiting; `stderr` is the raw
 * stderr line. Extracts a human-readable message from common error shapes.
 */
export function formatError(
  command: SubagentCommand,
  options: SubagentOptions,
  json: unknown | undefined,
  stderr: string,
): string {
  const detail = errorMessage(json) || stderr.trim() || "helper exited with an error";
  const target = commandTarget(command, options);
  return `Failed to ${command} ${target}: ${detail}`;
}

function errorMessage(json: unknown | undefined): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const obj = json as Record<string, unknown>;
  const msg = obj["message"];
  return typeof msg === "string" ? msg : undefined;
}

function commandTarget(command: SubagentCommand, options: SubagentOptions): string {
  switch (command) {
    case "spawn":
      return `subagent ${childName(options.label, options.agent)}`;
    case "prompt":
    case "wait":
    case "collect":
    case "close":
    case "read":
    case "unblock":
      return `subagent ${childName(options.label)}`;
    case "list":
      return "";
  }
}

interface HelperOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Parsed JSON from stdout when the helper emitted a JSON line. */
  json: unknown | undefined;
}

/**
 * Spawn the helper binary with `argv`, capture stdout/stderr, and parse the
 * JSON line the helper emits on stdout. Resolves on close (never rejects) so
 * the tool's `execute` can return a structured error result instead of
 * throwing. Respects the abort `signal`: the child is killed when it fires.
 */
export function runHelper(
  helper: string,
  argv: string[],
  signal: AbortSignal | undefined,
): Promise<HelperOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      const opts: Parameters<typeof spawn>[2] = {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      };
      if (signal) opts.signal = signal;
      child = spawn(helper, argv, opts);
    } catch (e) {
      resolve({
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        exitCode: 1,
        json: undefined,
      });
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let settled = false;
    const settle = (output: HelperOutput): void => {
      if (settled) return;
      settled = true;
      resolve(output);
    };

    child.on("error", (err) => {
      // spawn failure (ENOENT) or abort-signal kill. Surface as an error
      // result, not a throw.
      settle({ stdout, stderr: stderr || err.message, exitCode: 1, json: undefined });
    });

    child.on("close", (code, sig) => {
      const trimmed = stdout.trim();
      let json: unknown | undefined;
      if (trimmed.length > 0) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          // stdout was not JSON — leave json undefined
        }
      }
      const exitCode = code ?? 1;
      settle({ stdout, stderr, exitCode: sig ? 1 : exitCode, json });
    });
  });
}

const PROMPT_SNIPPET =
  "Delegate work to a child agent tab (spawn, prompt, collect, close, list, read, unblock).";

const PROMPT_GUIDELINES: string[] = [
  "Use `subagent` to delegate separable work to a child agent running in its own herdr tab — one tab, one task.",
  "`spawn`: options `{ kind: \"pi\"|\"claude\", label: string, agent?: string }`. `kind` is required and defaults to your own harness. Returns `{ pane_id, tab_id }` — keep both.",
  "`prompt`: options `{ pane_id: string, body: string }`. Wrap the body in `<supervisor-agent>…</supervisor-agent>` so the child knows it is a supervisor directive.",
  "`collect`: options `{ pane_id: string }`. Returns the child's last message as a descriptive summary including status, message, and whether the child is asking a question (`ask`). A question means reply, do not close.",
  "`close`: options `{ tab_id: string }`. Close a child once you have its result and no longer need it.",
  "`list`: no options. Shows every tracked child and its status — the durable backstop for a missed wake.",
  "`wait`: options `{ pane_id: string, timeout?: number }`. Rarely needed — your session auto-wakes you when a child reaches a terminal state. The abort signal interrupts a stuck wait.",
  "`read`: options `{ pane_id: string, lines?: number }`. Shows a child's pane — what a `blocked` child is waiting on. On a blocked child, read the pane and tell the human what to answer and in which tab; you are woken again when it resumes.",
  "`unblock`: options `{ pane_id: string, keys: string }`. Sends key presses to answer the dialog a `blocked` child is stalled on, e.g. `keys: \"enter\"` or `keys: \"1 enter\"`. Use it ONLY when the human has explicitly told you to answer that dialog — never on your own judgement. Rejected unless the child really is blocked.",
  "Prefer breadth (several children at your level) over deep chains. Close children before spawning the next batch. Invoke `/skill:delegate` for the full protocol.",
];

const DESCRIPTION = [
  "Delegate work to child agents via the herdr helper.",
  "Pass `command` (spawn|prompt|wait|collect|list|close|read|unblock) and the relevant `options`.",
  "Each command returns a descriptive summary of what happened.",
].join(" ");

/** The `subagent` tool definition, exported for registration and testing. */
export const subagentTool: ToolDefinition<typeof subagentSchema, SubagentToolDetails> = defineTool({
  name: "subagent",
  label: "Subagent delegation",
  description: DESCRIPTION,
  promptSnippet: PROMPT_SNIPPET,
  promptGuidelines: PROMPT_GUIDELINES,
  parameters: subagentSchema,
  async execute(
    _toolCallId: string,
    params: SubagentParams,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentToolDetails>> {
    const command = params.command;
    const argv = buildHelperArgs(command, params.options ?? {});

    // Resolve the child's label from the registry for commands that don't
    // carry it in options. Done before the main command so close — which
    // removes the registry entry — still finds the label.
    let formatOptions = params.options ?? {};
    if (formatOptions.label === undefined && command !== "spawn" && command !== "list") {
      const label = await resolveLabel(formatOptions);
      if (label) formatOptions = { ...formatOptions, label };
    }

    const output = await runHelper(helperPath(), argv, signal);
    const details: SubagentToolDetails = { command, exitCode: output.exitCode };

    // Success: return a descriptive summary, not raw JSON.
    if (output.exitCode === 0 && output.json !== undefined) {
      return {
        content: [{ type: "text", text: formatResult(command, formatOptions, output.json) }],
        details,
      };
    }

    // Failure: throw a descriptive error.
    throw new Error(formatError(command, formatOptions, output.json, output.stderr));
  },
});

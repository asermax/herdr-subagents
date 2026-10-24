// The `subagent` tool's harness-agnostic core: the command surface, the
// helper argv each command maps to, the descriptive text each result reads
// as, and the guidance the model gets. Node-free and import-free on purpose —
// the pi extension imports it, and the Claude mod bundles it into a hooks
// module, whose environment has no Node.

export type Harness = "pi" | "claude";

export const COMMANDS = [
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

/**
 * The commands a harness's tool exposes. Claude drops `wait`: the mod wakes
 * the parent itself, and a hooks module's process call is capped at ten
 * minutes, so a blocking wait could not honour long budgets anyway.
 */
export function commandsFor(harness: Harness): readonly SubagentCommand[] {
  return harness === "pi" ? COMMANDS : COMMANDS.filter((command) => command !== "wait");
}

/** Flat options shared across all commands; only the relevant subset is used per command. */
export interface SubagentOptions {
  kind?: string;
  agent?: string;
  label?: string;
  model?: string;
  worktree?: boolean;
  branch?: string;
  base?: string;
  pane_id?: string;
  tab_id?: string;
  body?: string;
  body_file?: string;
  timeout?: number;
  keys?: string;
  lines?: number;
}

/** The per-option descriptions both harnesses' input schemas carry. */
export const OPTION_DESCRIPTIONS = {
  agent: "Agent name — the definition's system prompt is applied automatically (never a path)",
  label: "Tab label",
  model:
    "Model the child's harness runs; qualify as provider/model when the bare id exists on several providers; omitted, the harness default (spawn only)",
  body: "Prompt body wrapped in <supervisor-agent> — the initial prompt on spawn, the message on prompt",
  body_file:
    "Path to a file whose content is the prompt body — alternative to body (absolute, or relative to the cwd)",
  worktree: "Give the child its own git worktree (spawn only)",
  branch: "Worktree branch; an existing one is joined (spawn only)",
  base: "Ref a new worktree branch forks from (spawn only)",
  pane_id: "Pane id",
  tab_id: "Tab id",
  timeout: "Timeout in ms (wait only)",
  keys: 'Space-separated key names, e.g. "1 enter" (unblock only)',
  lines: "Screen lines to read (read only)",
} as const;

/**
 * The tool's input as a plain JSON schema. pi builds the same shape with
 * typebox; the Claude mod registers this one.
 */
export function inputSchemaFor(harness: Harness): Record<string, unknown> {
  const string = (description: string) => ({ type: "string", description });
  const number = (description: string) => ({ type: "number", description });
  const boolean = (description: string) => ({ type: "boolean", description });

  return {
    type: "object",
    properties: {
      command: { type: "string", enum: [...commandsFor(harness)] },
      options: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["pi", "claude"] },
          agent: string(OPTION_DESCRIPTIONS.agent),
          label: string(OPTION_DESCRIPTIONS.label),
          model: string(OPTION_DESCRIPTIONS.model),
          body: string(OPTION_DESCRIPTIONS.body),
          body_file: string(OPTION_DESCRIPTIONS.body_file),
          worktree: boolean(OPTION_DESCRIPTIONS.worktree),
          branch: string(OPTION_DESCRIPTIONS.branch),
          base: string(OPTION_DESCRIPTIONS.base),
          pane_id: string(OPTION_DESCRIPTIONS.pane_id),
          tab_id: string(OPTION_DESCRIPTIONS.tab_id),
          ...(harness === "pi" ? { timeout: number(OPTION_DESCRIPTIONS.timeout) } : {}),
          keys: string(OPTION_DESCRIPTIONS.keys),
          lines: number(OPTION_DESCRIPTIONS.lines),
        },
      },
    },
    required: ["command"],
  };
}

/**
 * Map `{ command, options }` to the helper CLI argv slice (post-subcommand
 * token). Pure — no I/O — so it is unit-tested directly. Mirrors the helper's
 * own flag/positional conventions (cli.ts):
 *
 * | command  | argv                                                    |
 * | -------- | ------------------------------------------------------- |
 * | spawn    | `spawn --kind <kind> --label <label> [--agent <agent>] [--model <model>] [--body <body> | --body-file <path>] [--worktree [--branch <b>] [--base <r>]]` |
 * | prompt   | `prompt <pane_id> --body <body> | --body-file <path>`                        |
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
      if (options.model) args.push("--model", options.model);
      if (options.body) args.push("--body", options.body);
      if (options.body_file) args.push("--body-file", options.body_file);
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
      if (options.body_file) args.push("--body-file", options.body_file);
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

interface SpawnResultJson {
  pane_id: string;
  tab_id: string;
  prompt?: { sent: boolean };
}

interface WaitResultJson {
  pane_id: string;
  status: string;
  timed_out?: boolean;
}

interface ListChildJson {
  pane_id: string;
  tab_id: string;
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

/**
 * Format the helper's JSON output as a descriptive one-liner (or short block)
 * for each command. Pure — no I/O — so it is unit-tested directly. The result
 * never echoes a prompt body: the tool-call arguments already carry it, and
 * repeating it doubles the context cost of every delegation.
 */
export function formatResult(
  command: SubagentCommand,
  options: SubagentOptions,
  json: unknown,
): string {
  switch (command) {
    case "spawn": {
      const r = json as SpawnResultJson;
      const name = childName(options.label, options.agent);
      const ids = ` (pane_id ${r.pane_id}, tab_id ${r.tab_id})`;
      if (r.prompt?.sent) return `Started subagent ${name}${ids} and sent its prompt`;
      return `Started subagent ${name}${ids}`;
    }
    case "prompt": {
      const name = childName(options.label);
      return `Sent prompt to subagent ${name}`;
    }
    case "wait": {
      const r = json as WaitResultJson;
      const name = childName(options.label);
      if (r.timed_out) {
        return `Timed out waiting for subagent ${name} — nothing new; re-arm the wait`;
      }
      return `Subagent ${name} is ${r.status}`;
    }
    case "collect": {
      const r = json as CollectResultJson;
      const name = childName(r.label, r.agent, options.label);
      if (r.error) return `Subagent ${name} (${r.pane_id}) errored: ${r.error}`;
      if (r.ask) return `Subagent ${name} (${r.pane_id}) is asking:\n${r.message ?? ""}`;
      if (r.message) return `Subagent ${name} (${r.pane_id}, ${r.status}):\n${r.message}`;
      return `Subagent ${name} (${r.pane_id}) is ${r.status} with no message yet`;
    }
    case "list": {
      const r = json as ListResultJson;
      if (!r.children || r.children.length === 0) return "No children tracked.";
      const lines = r.children.map(
        (c) => `  ${c.label || c.pane_id}: ${c.status} (pane_id ${c.pane_id}, tab_id ${c.tab_id})`,
      );
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
  const detail = errorMessage(json) || stderr.trim() || "the subagent command exited with an error";
  let message: string;
  // A spawn with a body can fail at delivery: the child is live and tracked,
  // so "failed to spawn" would misread as a dead child. The retry hint names
  // this tool — never the helper binary the model must not learn about.
  if (command === "spawn" && failureReason(json) === "delivery") {
    const paneId = stringField(json, "pane_id");
    const retry =
      paneId === undefined
        ? ""
        : ` — retry with this tool's prompt command: { pane_id: "${paneId}", body: "<supervisor-agent>…</supervisor-agent>" }`;
    message = `Subagent ${childName(options.label, options.agent)} spawned but its prompt was not delivered: ${detail}${retry}`;
  } else {
    const target = commandTarget(command, options);
    message = `Failed to ${command} ${target}: ${detail}`;
  }
  // The evidence the helper captured from the child's pane (why a delivery
  // failed, what a blocked child sits on) rides the error JSON.
  const screen = stringField(json, "screen");
  return screen === undefined ? message : `${message}\nThe child's pane:\n${screen}`;
}

function stringField(json: unknown | undefined, field: string): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const value = (json as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function failureReason(json: unknown | undefined): string | undefined {
  return stringField(json, "reason");
}

function errorMessage(json: unknown | undefined): string | undefined {
  return stringField(json, "message");
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

// Required options per command. Checked before the helper runs so a malformed
// call never reaches the CLI and surfaces its usage text.
export function missingOption(
  command: SubagentCommand,
  options: SubagentOptions,
): string | undefined {
  switch (command) {
    case "spawn":
      return !options.kind ? "kind" : !options.label ? "label" : undefined;
    case "prompt":
      return !options.pane_id
        ? "pane_id"
        : options.body === undefined && options.body_file === undefined
          ? "body"
          : undefined;
    case "wait":
    case "collect":
    case "read":
      return !options.pane_id ? "pane_id" : undefined;
    case "close":
      return !options.tab_id ? "tab_id" : undefined;
    case "unblock":
      return !options.pane_id ? "pane_id" : !options.keys ? "keys" : undefined;
    case "list":
      return undefined;
  }
}

// --- running a command ---------------------------------------------------

/** What one helper run produced. */
export interface HelperOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Parsed JSON from stdout when the helper emitted a JSON line. */
  json: unknown | undefined;
}

/** Runs the helper with an argv slice; each harness supplies its own process call. */
export type HelperRunner = (argv: string[]) => Promise<HelperOutput>;

/** The parsed JSON line of a helper's stdout, or undefined when it emitted none. */
export function parseHelperJson(stdout: string): unknown | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export interface SubagentOutcome {
  isError: boolean;
  text: string;
}

/**
 * One tool call end to end: validate, resolve the child's label, run the
 * helper, and describe what happened. Never throws on a helper failure — the
 * caller turns `isError` into its harness's error result.
 */
export async function runSubagent(
  command: SubagentCommand,
  options: SubagentOptions,
  run: HelperRunner,
): Promise<SubagentOutcome> {
  // Validate here so a malformed call fails with the tool's own message;
  // delegated to the helper, it would surface the CLI's usage text, which
  // names the binary the model must never learn about.
  const missing = missingOption(command, options);
  if (missing !== undefined) {
    return { isError: true, text: `\`${missing}\` is required for \`${command}\`` };
  }

  // Resolve the child's label from the registry for commands that don't
  // carry it in options. Done before the main command so close — which
  // removes the registry entry — still finds the label.
  let formatOptions = options;
  if (formatOptions.label === undefined && command !== "spawn" && command !== "list") {
    const label = await resolveLabel(formatOptions, run);
    if (label) formatOptions = { ...formatOptions, label };
  }

  const output = await run(buildHelperArgs(command, options));

  if (output.exitCode === 0 && output.json !== undefined) {
    return { isError: false, text: formatResult(command, formatOptions, output.json) };
  }

  return { isError: true, text: formatError(command, formatOptions, output.json, output.stderr) };
}

/**
 * Look up a child's label from the registry via `helper list`. Used by
 * commands whose own result carries no label (prompt, wait, close). Must be
 * called BEFORE close — close removes the registry entry.
 */
async function resolveLabel(
  options: SubagentOptions,
  run: HelperRunner,
): Promise<string | undefined> {
  const output = await run(["list"]);
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

// --- model-facing guidance -----------------------------------------------

export const PROMPT_SNIPPET =
  "Delegate work to a child agent tab (spawn, prompt, collect, close, list, read, unblock).";

/** How the delegate skill is invoked on each harness. */
const SKILL_INVOCATION: Record<Harness, string> = {
  pi: "/skill:delegate",
  claude: "/delegate",
};

/** The per-command guidance the model reads alongside the tool. */
export function promptGuidelines(harness: Harness): string[] {
  return [
    "Use `subagent` to delegate separable work to a child agent running in its own herdr tab — one tab, one task.",
    "`spawn`: options `{ kind: \"pi\"|\"claude\", label: string, agent?: string, model?: string, body?: string, body_file?: string, worktree?: boolean, branch?: string, base?: string }`. `kind` is required and defaults to your own harness. `model` runs the child on a specific model; omitted, the harness's default applies — when you choose one, pick the cheapest model that can solve the task. Pass `body` (wrapped in `<supervisor-agent>…</supervisor-agent>`) to send the task in the same call, or `body_file` with a path to a file whose content is the body (absolute, or relative to the cwd). Returns `{ pane_id, tab_id }` — keep both.",
    "`agent` (spawn only) runs the child under a named agent definition: the child's system prompt is set from the definition automatically, at spawn. Pass only the name — never a path, never the definition pasted into `body`, and never an instruction for the child to read the file." +
      (harness === "pi" ? " On pi, definitions are `.md` files under the project's `.pi/agents/`." : ""),
    "`prompt`: options `{ pane_id: string, body: string }` or `{ pane_id: string, body_file: string }`. Follow-up prompts to a spawned child. Wrap the body in `<supervisor-agent>…</supervisor-agent>` so the child knows it is a supervisor directive.",
    "`collect`: options `{ pane_id: string }`. Returns the child's last message as a descriptive summary including status, message, and whether the child is asking a question (`ask`). A question means reply, do not close.",
    "`close`: options `{ tab_id: string }`. Close a child once you have its result and no longer need it.",
    "`list`: no options. Shows every tracked child and its status — the durable backstop for a missed wake.",
    ...(harness === "pi"
      ? [
          "`wait`: options `{ pane_id: string, timeout?: number }`. Rarely needed — your session auto-wakes you when a child reaches a terminal state. The abort signal interrupts a stuck wait.",
        ]
      : []),
    "`read`: options `{ pane_id: string, lines?: number }`. Shows a child's pane — what a `blocked` child is waiting on. On a blocked child, read the pane and tell the human what to answer and in which tab; you are woken again when it resumes.",
    "`unblock`: options `{ pane_id: string, keys: string }`. Sends key presses to answer the dialog a `blocked` child is stalled on, e.g. `keys: \"enter\"` or `keys: \"1 enter\"`. Use it ONLY when the human has explicitly told you to answer that dialog — never on your own judgement. Rejected unless the child really is blocked.",
    `Prefer breadth (several children at your level) over deep chains. Close children before spawning the next batch. Invoke \`${SKILL_INVOCATION[harness]}\` for the full protocol.`,
  ];
}

/** The tool's one-paragraph description. */
export function toolDescription(harness: Harness): string {
  return [
    "Delegate work to child agents in herdr tabs.",
    `Pass \`command\` (${commandsFor(harness).join("|")}) and the relevant \`options\`.`,
    "Each command returns a descriptive summary of what happened.",
  ].join(" ");
}

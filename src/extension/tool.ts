import { spawn } from "node:child_process";
import { Type, type Static } from "typebox";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { helperPath } from "./parent-role.js";
import {
  OPTION_DESCRIPTIONS,
  PROMPT_SNIPPET,
  parseHelperJson,
  promptGuidelines,
  runSubagent,
  toolDescription,
  type HelperOutput,
  type SubagentCommand,
} from "../core/subagent.js";

export {
  buildHelperArgs,
  formatError,
  formatResult,
  type SubagentCommand,
  type SubagentOptions,
} from "../core/subagent.js";

// The `subagent` tool on pi — one LLM-callable tool that wraps the full helper
// surface. The command surface, argv mapping and result text live in
// ../core/subagent.ts, shared with the Claude mod; this file binds them to
// pi's tool API and to a Node child process. `watch` is excluded — the
// extension already runs `helper watch` via parent-role.ts.

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
    agent: Type.Optional(Type.String({ description: OPTION_DESCRIPTIONS.agent })),
    label: Type.Optional(Type.String({ description: OPTION_DESCRIPTIONS.label })),
    model: Type.Optional(Type.String({ description: OPTION_DESCRIPTIONS.model })),
    body: Type.Optional(Type.String({ description: OPTION_DESCRIPTIONS.body })),
    body_file: Type.Optional(Type.String({ description: OPTION_DESCRIPTIONS.body_file })),
    worktree: Type.Optional(Type.Boolean({ description: OPTION_DESCRIPTIONS.worktree })),
    branch: Type.Optional(Type.String({ description: OPTION_DESCRIPTIONS.branch })),
    base: Type.Optional(Type.String({ description: OPTION_DESCRIPTIONS.base })),
    pane_id: Type.Optional(Type.String({ description: OPTION_DESCRIPTIONS.pane_id })),
    tab_id: Type.Optional(Type.String({ description: OPTION_DESCRIPTIONS.tab_id })),
    timeout: Type.Optional(Type.Number({ description: OPTION_DESCRIPTIONS.timeout })),
    keys: Type.Optional(Type.String({ description: OPTION_DESCRIPTIONS.keys })),
    lines: Type.Optional(Type.Number({ description: OPTION_DESCRIPTIONS.lines })),
  }),
});

export type SubagentParams = Static<typeof subagentSchema>;

export interface SubagentToolDetails {
  command: SubagentCommand;
  exitCode: number;
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
      const exitCode = code ?? 1;
      settle({ stdout, stderr, exitCode: sig ? 1 : exitCode, json: parseHelperJson(stdout) });
    });
  });
}

/** The `subagent` tool definition, exported for registration and testing. */
export const subagentTool: ToolDefinition<typeof subagentSchema, SubagentToolDetails> = defineTool({
  name: "subagent",
  label: "Subagent delegation",
  description: toolDescription("pi"),
  promptSnippet: PROMPT_SNIPPET,
  promptGuidelines: promptGuidelines("pi"),
  parameters: subagentSchema,
  async execute(
    _toolCallId: string,
    params: SubagentParams,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    _ctx: ExtensionContext,
  ): Promise<AgentToolResult<SubagentToolDetails>> {
    const command = params.command;
    let exitCode = 0;

    const outcome = await runSubagent(command, params.options ?? {}, async (argv) => {
      const output = await runHelper(helperPath(), argv, signal);
      exitCode = output.exitCode;
      return output;
    });

    if (outcome.isError) throw new Error(outcome.text);

    return {
      content: [{ type: "text", text: outcome.text }],
      details: { command, exitCode },
    };
  },
});

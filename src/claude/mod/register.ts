import {
  inputSchemaFor,
  parseHelperJson,
  promptGuidelines,
  runSubagent,
  toolDescription,
  type SubagentCommand,
  type SubagentOptions,
} from "../../core/subagent.js";
import { startParentRole, type Host, type WatchChunk } from "./parent-role.js";

// The herdr-subagents Claude mod (a hooks module). It gives Claude what the pi
// extension gives pi:
//   - the `subagent` tool, served by running the bundled helper
//   - the parent role: `helper watch` for the session, the fleet on the status
//     line, and a wake prompt when a child needs the parent
//
// The child onboarding stays a classic SessionStart command hook (hooks.json):
// on a machine with managed settings the built-in security plugin keeps
// user-tier plugins out of `prompt.compose` and `prompt.context`.
//
// Every `$` call lives in this file (`claude plugin validate` follows `$`);
// the logic lives in ../../core and ./parent-role.ts. The build bundles this
// entry into one `hooks/register.js`, since a hooks module has no Node and may
// only import files of its own plugin.

// The engine's types are written per install, not published, so this module
// declares the slice it uses.
interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Engine {
  plugin: { root: string };
  env: { get: (name: string) => Promise<string | undefined> };
  process: {
    run: (
      argv: readonly string[],
      init?: { timeoutMs?: number },
    ) => Promise<ProcessRunResult>;
    spawn: (request: { argv: readonly string[] }) => AsyncIterable<WatchChunk>;
  };
  tool: {
    register: (spec: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      isDeferred: boolean;
    }) => Promise<{ tool: string }>;
  };
  ui: {
    status: (text: string | undefined) => void;
    log: (text: string) => void;
  };
  prompt: { submit: (input: { text: string }) => Promise<unknown> };
  clock: { after: (ms: number, fn: () => void) => { cancel: () => void } };
}

type Next<E, R> = ((e: E) => Promise<R>) & { called: boolean };
type Hook<E, R> = ($: Engine, e: E, next: Next<E, R>) => Promise<R> | R;

interface Registration<E, R> {
  catch: (handler: Hook<E, R>) => void;
}

interface SessionStart {
  isInteractive: boolean;
}

interface ToolCall {
  tool: string;
  command?: SubagentCommand;
  options?: SubagentOptions;
}

type ToolCallResult = { result: string } | { deny: string };

interface On {
  (event: "session.start", hook: Hook<SessionStart, unknown>): void;
  (event: "session.end", hook: Hook<unknown, unknown>): void;
  (event: "tool.call", hook: Hook<ToolCall, ToolCallResult>): Registration<ToolCall, ToolCallResult>;
}

// The helper can wait on a child for a while (spawn verifies the child came up
// and acted on its prompt), so every run gets the engine's ceiling.
const HELPER_TIMEOUT_MS = 10 * 60 * 1000;

// Every function `$` reaches is a declaration, not an arrow: `claude plugin
// validate` reads the bundle statically and follows `$` only into function
// declarations (the bundler turns a top-level `const` into a `var`).

async function helperOf($: Engine): Promise<string> {
  return (await $.env.get("HERDR_SUBAGENT_HELPER")) || `${$.plugin.root}/bin/herdr-helper`;
}

// The dev loop: a parent started with `--plugin-dir` hands the same plugin to
// its Claude children. The helper forwards whatever spawn flags it does not
// consume onto the child's argv, and every HERDR_SUBAGENT_* variable onto its
// environment, so the variable carries the plugin down every level.
async function devArgsOf($: Engine, e: ToolCall): Promise<string[]> {
  if (e.command !== "spawn" || e.options?.kind !== "claude") return [];

  const pluginDir = await $.env.get("HERDR_SUBAGENT_PLUGIN_DIR");
  return pluginDir ? ["--plugin-dir", pluginDir] : [];
}

function hostOf($: Engine, helper: string): Host {
  return {
    watch: () => $.process.spawn({ argv: [helper, "watch"] }),
    status: (text) => $.ui.status(text),
    submit: (text) => $.prompt.submit({ text }),
    after: (ms, fn) => $.clock.after(ms, fn),
  };
}

export function register(on: On): void {
  let toolName: string | undefined;
  let stopParentRole: (() => void) | undefined;

  on("session.start", async ($, e, next) => {
    const started = await next(e);

    try {
      const registered = await $.tool.register({
        name: "subagent",
        description: [toolDescription("claude"), ...promptGuidelines("claude")].join("\n\n"),
        inputSchema: inputSchemaFor("claude"),
        // Not behind ToolSearch: the delegate skill expects the tool at hand.
        isDeferred: false,
      });
      toolName = registered.tool;
    } catch (error) {
      $.ui.log(
        `herdr-subagents: the subagent tool is not available in this session (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    // The parent role needs a person's session inside herdr: the registry the
    // watch reads is keyed on the herdr pane this session runs in.
    if (e.isInteractive && (await $.env.get("HERDR_PANE_ID")) && stopParentRole == null) {
      stopParentRole = startParentRole(hostOf($, await helperOf($)));
    }

    return started;
  });

  on("session.end", async (_$, e, next) => {
    stopParentRole?.();
    stopParentRole = undefined;
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    if (toolName == null || e.tool !== toolName) return next(e);

    if (e.command == null) return { deny: "`command` is required" };

    const helper = await helperOf($);
    const devArgs = await devArgsOf($, e);
    const outcome = await runSubagent(e.command, e.options ?? {}, async (argv) => {
      try {
        const { exitCode, stdout, stderr } = await $.process.run([helper, ...argv, ...devArgs], {
          timeoutMs: HELPER_TIMEOUT_MS,
        });
        return { exitCode, stdout, stderr, json: parseHelperJson(stdout) };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          json: undefined,
        };
      }
    });

    return outcome.isError ? { deny: outcome.text } : { result: outcome.text };
  }).catch((_$, e, next) => (next.called ? next(e) : { deny: "The subagent tool failed" }));
}

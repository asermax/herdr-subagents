# The helper is a tool on claude too

Claude Code now runs hooks modules ("mods"), which can register LLM-callable tools, run long-lived processes, draw a status line, and submit prompts. The claude plugin ships a mod that gives claude what the pi extension gives pi: the `subagent` tool, `helper watch` for the session, the fleet on the status line, and a wake prompt when a child needs the parent. Bash invocation of the helper is gone; there is no fallback for Claude Code builds without mods.

Supersedes the claude half of ADR-0006.

## Decision

- **One core, two bindings.** The command surface, argv mapping, result text, guidance (`src/core/subagent.ts`) and the watch-line logic (`src/core/fleet.ts`) are Node-free and import-free. The pi extension imports them; the mod (`src/claude/mod/`) bundles them. The build bundles the mod into one `hooks/register.js` with esbuild (platform neutral), because a hooks module has no Node and may only import its own plugin's files.
- **No `wait` on claude.** A mod's `$.process.run` is capped at ten minutes, and the mod wakes the parent itself, so the claude tool drops `wait`. pi keeps it.
- **The wake is a submitted prompt.** `$.prompt.submit` starts a turn once the session is idle and cannot be withdrawn, so the mod keeps at most one queued: wakes that arrive while one is queued fold into the next prompt. The wake is visible in the transcript (pi's is hidden); a mod has no hidden message that starts a turn.
- **Onboarding stays a classic SessionStart hook.** On a machine with managed settings, the built-in security plugin skips user-tier plugins on `prompt.compose` and `prompt.context`, so a mod cannot add the onboarding there. `hooks.json` lists the mod under `modules` and keeps the command hook under `hooks`.
- **The token set shrinks to `{{invoke}}`.** Both harnesses wake the parent the same way, so the wake text lives in the protocol, and no skill names the helper, so `{{helper}}` is gone.

## Constraints the bundle must meet

`claude plugin validate` reads the module statically: `register` must be a function declaration, and `$` may only be passed into function declarations (the bundler turns a top-level `const` into a `var`, which the validator does not follow). Env variable names passed to `$.env.get` must be string literals.

## Consequences

- The dev loop for claude children moves from argv to env: a parent launched with `HERDR_SUBAGENT_PLUGIN_DIR` passes `--plugin-dir <dir>` on each claude spawn, and the helper forwards the variable to every child.
- The parent role needs an interactive session inside herdr (`HERDR_PANE_ID`): the registry `watch` reads is keyed on the parent's pane.
- The tool's registered name is the engine's (`mcp__herdr-subagents__subagent`); the mod matches calls against the name `$.tool.register` returns, not a hardcoded one.

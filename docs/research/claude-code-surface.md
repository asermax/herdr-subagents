# Claude Code surface: subagents launched from a shell, and packaging as a plugin

Research for the herdr-subagents system, where a parent coding agent launches
`claude` as a fresh herdr tab with an agent definition, briefs it, and collects
its final message. We ship the parent-facing delegate skill and the child's
onboarding injection as a Claude Code plugin; collection is parent-side (the
parent reads the child's transcript, not a hook push). `.claude/agents/*.md` is
the canonical agent-definition format for **both** claude and pi, so this pins
its schema.

**Sources.** Installed binary `claude` v2.1.220 at `/usr/bin/claude`, the local
config tree under `/home/agus/.claude/` (agents, hooks, plugins, settings), and
official Anthropic docs. The docs URL
`https://docs.claude.com/en/docs/claude-code/<page>` 301-redirects to the
canonical `https://code.claude.com/docs/en/<page>`; this doc cites the canonical
form. The live docs are authoritative; where a secondary source disagrees,
the live docs win.

Two claims were verified empirically against the installed binary rather than
trusted from docs; they are marked **verified** below.

---

## 1. `--agent` — launching `claude` from a shell

### Semantics

`claude --help`:

```
--agent <agent>   Agent for the current session. Overrides the 'agent' setting.
```

`--agent` takes a **name** (an agent identifier), not a path. It runs the whole
session **as** that agent: the agent's system prompt **replaces the default
Claude Code system prompt entirely** (same effect as `--system-prompt`), and the
session inherits the agent's `tools`, `disallowedTools`, `model`, `effort`,
`mcpServers`, `permissionMode`, and `hooks` from its frontmatter.

```shellscript
claude --agent code-reviewer
```

The agent name appears as `@<name>` in the startup header so you can confirm it
is active. (`claude --agent`, official docs: "Run the whole session as a
subagent".)

### Where agent names are searched (precedence)

`--agent` resolves the name against the same registry every other agent
reference uses. From `claude --help` (`--agents`) and the sub-agents doc
("Choose the subagent scope"), precedence is highest to lowest:

| # | Source | Scope |
|---|--------|-------|
| 1 | Managed settings `.claude/agents/` | Organization-wide |
| 2 | `--agents` CLI flag (JSON) | Current session only, not persisted |
| 3 | `.claude/agents/` (project), walking up from cwd to repo root | Project |
| 4 | `~/.claude/agents/` (user) | All your projects |
| 5 | Plugin `agents/` directories | Where the plugin is enabled |

On the installed machine, `~/.claude/agents/` is empty, so the only resolvable
agents are the built-ins plus plugin agents. This was confirmed directly:

```
$ claude -p --agent nonexistent-agent-xyz "hi"
--agent 'nonexistent-agent-xyz' not found. Available agents: claude, Explore,
general-purpose, Plan, ..., <plugin-name>:<agent-name>
```

The "Available agents" line shows built-ins and **plugin-scoped names**
(`<plugin-name>:<agent-name>`), confirming plugin agents are reached via that
scoped form.

### Interaction with other flags

- **Positional prompt**: a positional argument is the initial user prompt. It is
  sent after the agent's system prompt. If the agent defines `initialPrompt`
  frontmatter, that text is auto-submitted as the **first** user turn, and the
  positional prompt (if any) follows it (`initialPrompt` is "prepended to any
  user-provided prompt").
- **`--append-system-prompt <text>`**: appended to the **default** system prompt.
  Because `--agent` replaces the default system prompt entirely, the agent's body
  is the system prompt; `--append-system-prompt` then appends to that. Use this to
  inject herdr/parent context into a child run as `--agent`.
- **`--permission-mode <mode>`**: sets the session permission mode. An agent's own
  `permissionMode` frontmatter can override it, **except** when the parent is
  already `bypassPermissions` or `acceptEdits` (those take precedence and cannot
  be loosened). For plugin-shipped agents, `permissionMode` is ignored entirely.
- **`--model <alias|id>`**: sets the session model. Resolution order for an agent
  run is `CLAUDE_CODE_SUBAGENT_MODEL` env > per-invocation model > agent
  frontmatter `model` > main conversation model. So `--model` on the CLI wins
  over an agent's `model: opus` frontmatter.
- **`-p` / `--print`**: non-interactive; print the response and exit. Fully
  compatible with `--agent`. This is the shape herdr will use to collect a
  child's final message on stdout.
- **`--bg` / `--background`**: starts the session as a background agent and
  returns immediately (managed via `claude agents`). `--bg` plus `--agent` is the
  supported way to dispatch a specific subagent as a detached background session.
  `--bg` rejects `-p`/`--print` up front.

### Name not found

**Verified:** `claude -p --agent <missing>` exits non-zero (exit 1) and prints
`--agent '<name>' not found. Available agents: <list>`. With `--bg`, the docs
describe a softer variant: it prints a `no agent named` warning, reports the
session as backgrounded, then the session exits immediately with the same
`--agent '<name>' not found` error (the pre-v2.1.191 behavior was to fall back to
the default agent).

---

## 2. Agent definition format — `.claude/agents/*.md`

### Canonical frontmatter schema

The **authoritative source is the live sub-agents doc**.
A file is YAML frontmatter followed by a Markdown body. The body **is** the
system prompt.

**Required:** `name`, `description`. Everything else is optional.

| Field | Type | Effect |
|-------|------|--------|
| `name` | string | Identifier, lowercase letters + hyphens, 3–50 chars, must start/end alphanumeric. Cannot contain `:` (reserved for plugin scoping). Hooks receive it as `agent_type`. Filename need not match. |
| `description` | string | When Claude should delegate. Loaded into context at registration so the harness can dispatch. This is the most important field for auto-delegation. |
| `tools` | list | Allowlist of tools the agent can use. If omitted, inherits every tool available to subagents. Supports `Agent(worker, researcher)` sub-typing and `mcp__<server>` / `mcp__<server>__*` patterns. |
| `disallowedTools` | list | Denylist; applied before `tools` is resolved. `mcp__*` removes every MCP tool. |
| `model` | string | `sonnet`, `opus`, `haiku`, `fable`, a full model ID (`claude-opus-5`), or `inherit` (default). |
| `effort` | string | `low`/`medium`/`high`/`xhigh`/`max`. Overrides the session effort when this agent is active. |
| `permissionMode` | string | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, or `manual` (alias for `default`). **Ignored for plugin-shipped agents.** |
| `maxTurns` | integer | Max agentic turns before the agent stops. |
| `skills` | list | Skills preloaded into the agent's context at startup (full content injected, not just descriptions). |
| `mcpServers` | list | MCP servers available to this agent: string references to configured servers, or inline `{ name: {config} }` definitions. **Ignored for plugin-shipped agents.** |
| `hooks` | object | Lifecycle hooks scoped to this agent. `Stop` is auto-converted to `SubagentStop` at runtime. **Ignored for plugin-shipped agents.** |
| `memory` | string | `user`, `project`, or `local`. Persistent memory scope; enables cross-session learning. |
| `background` | boolean | `true` forces the agent to always run as a background task. When unset, Claude chooses (background is the default as of v2.1.198). |
| `isolation` | string | Only valid value is `"worktree"` — runs the agent in a temporary git worktree. |
| `color` | string | Display color. Live docs: `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`. |
| `initialPrompt` | string | Auto-submitted as the first user turn when this agent runs as the main session (via `--agent` or the `agent` setting). Commands and skills are processed. Prepended to any user-provided prompt. |

A minimal valid agent:

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices
tools: Read, Glob, Grep
model: sonnet
---

You are a code reviewer. When invoked, analyze the code and provide
specific, actionable feedback on quality, security, and best practices.
```

### Plugin-provided agents and namespacing

Plugin agents live in the plugin's `agents/` directory (scanned recursively) and
are namespaced **automatically**:

- Single-level: `agents/code-reviewer.md` in plugin `my-plugin` registers as
  `my-plugin:code-reviewer`.
- Subfolder becomes part of the scoped id: `agents/review/security.md` registers
  as `my-plugin:review:security`.

**Security restriction:** for agents loaded from a plugin, `hooks`,
`mcpServers`, and `permissionMode` are **ignored**. If you need them, ship the
agent as a project/user file instead. (This matters for our design: a
plugin-shipped child agent cannot carry its own hooks, so any report-handoff hook
must live in the plugin's `hooks/hooks.json` or in user/project settings.)

### `--agents` (JSON, session-only)

You can define agents for a single session without any file via `--agents`. The
system prompt goes in a `prompt` field (the equivalent of the Markdown body):

```shellscript
claude --agents '{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer", "tools": ["Read","Grep"], "model": "sonnet"}}'
```

Accepts the same fields as file frontmatter. Useful for automation and tests.

---

## 3. Hooks — `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`

### Hook locations and how plugins ship them

Hooks come from six sources (official "Hook locations" table): `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed policy settings, a **plugin's `hooks/hooks.json`**, or skill/agent frontmatter. A plugin's hooks **merge** with user and project hooks and run in parallel with them.

A plugin ships hooks as a JSON file (conventionally `hooks/hooks.json`) with a
top-level `description` (optional) wrapping a `hooks` object. For example:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear|compact",
        "hooks": [ { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" } ] }
    ]
  }
}
```

`type` is one of `command`, `http`, `mcp_tool`, `prompt`, or `agent`. Use
`${CLAUDE_PLUGIN_ROOT}` for portable paths to bundled scripts; it is substituted
in both shell form and exec form (exec form with `args` is preferred for paths).

User `settings.json` uses the same nesting but **without** the `description`
wrapper; hooks there merge with plugin hooks and run in parallel.

### Hook payloads

A `SessionStart` payload exposes these fields on stdin: `hook_event_name`,
`agent_id`, `session_id`, `transcript_path`, `source`. A registration hook can
forward `session_id` + `transcript_path` out-of-band to the parent (e.g. over a
unix socket). Note that recap/away-summary can emit `SubagentStop` after the
main turn has already stopped, so do not use it to revive an idle pane;
`SessionStart` does not carry the final assistant message (the transcript path
does).

### `Stop` hook — does it reach the final assistant message?

**Yes — directly.** This is the single most important finding and it was
**verified empirically** against `claude` v2.1.220 by capturing a real Stop
payload. The Stop event delivers the final assistant message inline as
`last_assistant_message`; you do **not** need to parse the transcript.

Captured Stop payload (from `claude -p --settings <capture> "Reply with exactly the word: done"`, lightly formatted):

```json
{
  "session_id": "c8553aaf-6eed-4d0e-b4e0-b4e47722a19c",
  "transcript_path": "/home/agus/.claude/projects/.../c8553aaf-....jsonl",
  "cwd": "/home/agus/workspace/asermax/herdr-subagents",
  "prompt_id": "04f14df4-e48a-4b86-87ec-56dbed74941b",
  "permission_mode": "bypassPermissions",
  "effort": { "level": "high" },
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "done",
  "background_tasks": [],
  "session_crons": []
}
```

Implications for the handoff design:

- `last_assistant_message` gives you the child's final message **inline**, no
  transcript parsing. This is the recommended field — the docs explicitly warn
  that `transcript_path` is "written asynchronously and may lag the in-memory
  conversation, so it may not yet include the current turn's most recent messages
  when a hook fires. Hooks that need the final assistant text of the current turn
  should use `last_assistant_message` on Stop and SubagentStop instead of reading
  the transcript."
- `stop_hook_active` is the re-entrancy guard: the docs cap a Stop hook at 8
  consecutive blocks; check this field and exit 0 when `true` to avoid the cap.
- `background_tasks` is present on Stop, so the hook can also see live task ids.

### `SubagentStop`

Same shape and same `last_assistant_message` guarantee, but fires when a
**subagent** (not the main thread) finishes. Matcher filters on agent type (e.g.
`db-agent`, or `^my-plugin:reviewer$` for a plugin-scoped name). When an agent
defines `Stop` hooks in its **frontmatter**, they are auto-converted to
`SubagentStop` at runtime. Note the herdr script's caveat: recap/away-summary can
emit `SubagentStop` after the main turn has already stopped, so do not use it to
revive an idle pane.

### `SessionStart`

Fires when a session begins or resumes. Matcher is the start reason:
`startup | resume | clear | compact | fork`. Common fields plus `source`.
SessionStart is special: anything written to **stdout** is injected into
Claude's context, and it can persist env vars by writing `export VAR=...` lines
to the `$CLAUDE_ENV_FILE` path. `model` may be present (not guaranteed). This is
the natural place for a plugin to register a child's session id with the parent.

### `SessionEnd`

Fires when a session terminates. Matcher is the reason: `clear | resume | logout
| prompt_input_exit | bypass_permissions_disabled | other`. All `SessionEnd`
hooks share a **1.5-second budget** (raised up to 60s if your per-hook `timeout`
asks for more). Cannot block. Use for cleanup/logging. Because of the tight
budget, do heavy work elsewhere.

### Exit-code and JSON-output contract (all command hooks)

- **exit 0**: success. stdout is parsed for JSON output fields. For most events
  stdout is debug-logged, not shown. Exceptions — `UserPromptSubmit`,
  `UserPromptExpansion`, `SessionStart` — add stdout to Claude's context.
- **exit 2**: blocking error; stderr is fed back to Claude as the reason. Effect
  depends on event (`PreToolUse` blocks the call, `UserPromptSubmit` rejects the
  prompt, etc.).
- **any other exit**: non-blocking error; transcript shows `<hook> hook error`
  plus the first stderr line; execution continues.

Structured output (exit 0 + JSON on stdout) is how you exert control:
`Stop`/`PostToolUse` use a top-level `decision: "block"` with a `reason`;
`PreToolUse` uses `hookSpecificOutput.permissionDecision` of `allow | deny | ask
| defer`; `UserPromptSubmit` uses `hookSpecificOutput.additionalContext` to
inject text (must be nested under `hookSpecificOutput`).

---

## 4. Background tasks — how a completed task notifies the agent

Claude Code has three overlapping "background" mechanisms. For our design (a
child's report arriving the way a finished background job does), the relevant
distinction is **synchronous delegation** vs. **detached background sessions**.

### (a) Subagent delegation via the Agent tool (synchronous)

A parent spawns a subagent with the `Agent` tool. The subagent runs in its own
context window and **returns its final message as the tool result** to the
parent — the parent's turn blocks on the `Agent` call and resumes with the
child's summary injected as a `tool_result`. As of v2.1.198, subagents run in the
**background by default**, but from the parent's perspective the `Agent` tool
call still resolves with the child's final text when the child finishes. This is
the cleanest "report arrives" path and needs no hook at all.

Background subagents keep a restricted built-in tool set (`Read, Grep, Glob,
Bash, PowerShell, Edit, Write, ...`) but all MCP tools. `TaskOutput`,
`AskUserQuestion`, `EnterPlanMode`, `ScheduleWakeup`, etc. are removed from
every subagent.

### (b) Detached background sessions (`claude --bg`, `/bg`, agent view)

`claude --bg "<prompt>"` (or `--background`) starts a full Claude Code
conversation with **no terminal attached**, managed by a separate **supervisor
process**. It prints a short id and returns immediately:

```
backgrounded · 7c5dcf5d · flaky-test-fix
  claude agents             list sessions
  claude attach 7c5dcf5d    open in this terminal
  claude logs 7c5dcf5d      show recent output
  claude stop 7c5dcf5d      stop this session
```

These are **not** injected into another agent's context. They are surfaced to
the **user** through **agent view** (`claude agents`): a table grouped by
`Needs input` / `Working` / `Completed`, with one-line summaries generated by a
Haiku-class model, peek/reply, and attach. Each background session edits files
in its own git worktree under `.claude/worktrees/`.

### (c) How completion is signaled — the real mechanism and its limits

When a detached background session finishes, the notification path is the
**`Notification` hook with matcher `agent_completed`** (requires v2.1.198+, and
fires **only while agent view is open**):

| `Notification` matcher | Fires when |
|------------------------|------------|
| `agent_needs_input` | A background session starts waiting on your input (agent view open) |
| `agent_completed` | A background session finishes or fails (agent view open) |

So a completed background job does **not** wake an arbitrary running agent
mid-turn by itself. It (1) updates the agent-view row state to `Completed`/
green, (2) fires the `Notification` hook with `agent_completed` (only if agent
view is open), and (3) the prompt-footer `←` hint in any open interactive
session briefly flashes the count (`← 2 done`) and refreshes ~every 10s. The
full result text lives in the session's transcript and in the row's end-of-turn
summary; it reaches a parent agent only when a human attaches, or when the parent
explicitly reads it (e.g. via `claude logs <id>`, the transcript path, or by
attaching and resuming).

Two additional, narrower "wake the agent" mechanisms exist:

- **`asyncRewake: true`** on a command hook — runs in the background and **wakes
  Claude on exit code 2**; the hook's stderr (or stdout if stderr is empty) is
  shown to Claude as a system reminder. This is the closest primitive to "a
  background thing pushes a message into a running agent mid-session," but it is
  scoped to hook scripts, not to other sessions.
- **Monitors** (plugin `monitors/monitors.json`, or the `Monitor` tool) — a
  long-running process whose every stdout line is delivered to Claude as a
  notification. These run only in interactive CLI sessions.

**Limits that matter for our design:** there is no built-in "background session A
finishes → its final message is injected into running session B's context"
channel. The `Notification(agent_completed)` hook fires only while agent view is
open and carries only the event, not the full message text. To get a child's
report into a parent the way a finished job arrives, either (i) use synchronous
`Agent`-tool delegation (the result returns as a tool_result — recommended), or
(ii) have the child's `Stop` hook (which **does** carry `last_assistant_message`,
see §3) deliver the report out-of-band to the parent (e.g. write to a file or socket
the parent reads).

---

## 5. Plugin packaging

### Manifest: `.claude-plugin/plugin.json`

The manifest is **optional** (Claude auto-discovers components in default
locations and derives the name from the directory if omitted), but we will ship
one. `name` (kebab-case) is the only required field. Recognized top-level fields:

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Required. Unique, kebab-case. Used for namespacing (`my-plugin:agent`). |
| `displayName` | string | Human-readable; may contain spaces. v2.1.143+. |
| `version` | string | Semver. If omitted, falls back to git commit SHA. |
| `description`, `author{name,email,url}`, `homepage`, `repository`, `license`, `keywords` | various | Metadata. |
| `defaultEnabled` | boolean | `false` ships installed-but-disabled. v2.1.154+. |
| `skills` | string\|array | **Adds to** default `skills/` scan. |
| `commands` | string\|array | **Replaces** default `commands/`. |
| `agents` | string\|array | **Replaces** default `agents/`. |
| `workflows`, `outputStyles` | string\|array | Replace defaults. |
| `hooks` | string\|array\|object | Path to hooks JSON, or inline. |
| `mcpServers` | string\|array\|object | Path to `.mcp.json`, or inline. |
| `lspServers` | string\|array\|object | LSP configs. |
| `experimental.themes`, `experimental.monitors` | string\|array | Experimental components. |
| `userConfig` | object | User-configurable values prompted at enable time; substitutable as `${user_config.KEY}` (exec-form only). |
| `channels` | array | MCP-backed message-injection channels. |
| `dependencies` | array | Other plugins this one requires, with optional semver constraints. |

Unrecognized top-level fields are **ignored** (so a manifest can double as a
`package.json`/VS Code extension manifest); `claude plugin validate --strict`
turns those warnings into errors for CI.

Minimal manifest:

```json
{
  "name": "herdr-subagents",
  "description": "Delegate coding-agent work by spawning other agents as herdr tabs.",
  "author": { "name": "Author Name" }
}
```

### Directory layout

Standard layout (all component dirs at the **plugin root**, never inside
`.claude-plugin/`):

```
my-plugin/
├── .claude-plugin/plugin.json   # manifest (optional)
├── skills/<name>/SKILL.md       # skills (auto-discovered)
├── commands/*.md                # flat skill/command files
├── agents/*.md                  # subagent definitions
├── hooks/hooks.json             # hook config (or inline in manifest)
├── .mcp.json                    # MCP servers (or inline)
├── .lsp.json                    # LSP servers (or inline)
├── monitors/monitors.json       # background monitors (experimental)
├── bin/                         # executables added to Bash PATH
├── scripts/                     # hook + utility scripts
└── settings.json                # only `agent` and `subagentStatusLine` keys supported
```

Auto-discovery: `.claude-plugin/plugin.json` is read on enable; `commands/`,
`agents/`, `skills/`, `hooks/hooks.json`, `.mcp.json` are scanned automatically.
Component path fields in the manifest **supplement or replace** defaults per the
table above (`skills` adds; `commands`/`agents`/`workflows`/`outputStyles`
replace).

### Path variables (use these, not hardcoded paths)

- `${CLAUDE_PLUGIN_ROOT}` — plugin install dir. Changes on every update.
- `${CLAUDE_PLUGIN_DATA}` — persistent dir (`~/.claude/plugins/data/{id}/`)
  that survives updates; use for `node_modules`, venvs, generated files.
- `${CLAUDE_PROJECT_DIR}` — project root.

All three are also exported as env vars to hook processes and MCP/LSP
subprocesses. Prefer **exec form** (`"command": "node", "args":
["${CLAUDE_PLUGIN_ROOT}/x.js"]`) so paths with spaces need no quoting.

### Installation: git repo vs. marketplace

- **Marketplace install** (copies plugin into the cache `~/.claude/plugins/cache`):
  add a marketplace (`extraKnownMarketplaces`), then `/plugin` → Discover, or
  `claude plugin`. Scopes: `user` (default, `~/.claude/settings.json`), `project`
  (`.claude/settings.json`, shareable), `local` (`.claude/settings.local.json`,
  gitignored), `managed` (admin). Real scopes seen in
  `~/.claude/plugins/installed_plugins.json` include `"scope": "user"` and
  `"scope": "local"` (per-project).
- **`--plugin-dir <path>`** (or `.zip`): loads a plugin for **this session only**,
  not installed. Repeatable. Great for development and for herdr pointing at a
  generated plugin tree.
- **`--plugin-url <url>`**: fetch a plugin `.zip` from a URL for this session only.
- **Skills-directory plugins**: any folder under a skills directory containing
  `.claude-plugin/plugin.json` loads as `<name>@skills-dir` with no install step
  (`~/.claude/skills/` personal scope, `<cwd>/.claude/skills/` project scope
  behind the workspace-trust gate).

### Constraints on shipping a skill whose text is generated

A few things constrain a skill whose body is produced from a shared source
(rather than hand-edited in place):

1. **Marketplace plugins are copied to the cache**, not run in place. Symlinks
   resolve only within the plugin's own dir (preserved) or within the same
   marketplace (dereferenced/copied); symlinks outside the marketplace are
   **dropped** for security. Path traversal (`../shared`) does not work after
   install. So a generated skill must either be materialized into the plugin at
   build time, or live in the same marketplace and be symlinked.
2. **Skills-directory plugins run in place** — edits to `SKILL.md` take effect
   immediately in the current session, but changes to other components
   (`hooks/`, `agents/`, `.mcp.json`) require `/reload-plugins` or a restart.
3. **A single `SKILL.md` at the plugin root** (no `skills/` dir, no `skills`
   field) auto-loads as a one-skill plugin; the invocation name comes from the
   frontmatter `name`, falling back to the directory basename — which for
   marketplace installs is a version string that changes on every update. So
   **always set `name` in the frontmatter** for a generated skill.
4. Boolean frontmatter (`disable-model-invocation`, etc.) accepts
   `yes/no/on/off/1/0` in any case as of v2.1.218 (previously only `true/false`).
5. Project-scope `@skills-dir` plugins load only from the `.claude/skills/` of
   the directory you start Claude in; they do **not** walk up to the repo root.

---

## Bottom line for the herdr-subagents design

- **Agent schema**: pin on the live-docs table in §2 (`name`, `description`
  required; rich optional fields). It works identically for claude (`--agent`,
  `.claude/agents/`) and pi, and is the shared contract.
- **Child report handoff is parent-side, not a hook.** The `Stop` hook *does*
  carry `last_assistant_message` inline (**verified**, §3), but the shipped
  design does not use it: collection is entirely parent-side. When a child
  reaches a terminal status, the parent resolves the child's transcript
  (`~/.claude/projects/<project>/<uuid>.jsonl`, from herdr's `agent_session`)
  and extracts the last complete assistant message itself. The plugin ships
  only a `SessionStart` onboarding hook; the `Stop` handoff was deliberately
  dropped (ADR-0002).
- **Plugin packaging**: ship `.claude-plugin/plugin.json` + `hooks/hooks.json`
  (SessionStart onboarding only) + `skills/delegate/SKILL.md` +
  `references/onboarding.md`. No `agents/` directory — agents live in the
  consuming project. For the generated skill, materialize it into the plugin
  at build time (cache-copy + symlink rules forbid `../` references) and always
  set `name` in the skill frontmatter. `--plugin-dir` is the dev/load path
  herdr points at directly.
- **Background completion does not auto-inject into a parent agent**: there is
  no built-in cross-session injection. On claude the parent arms the wake
  itself — it launches `helper wait <pane_id>` as a background task whose
  completion reminder brings it back to collect (the pi extension auto-wakes
  via its own watcher). The child's report still arrives through parent-side
  collect, never through a hook push.

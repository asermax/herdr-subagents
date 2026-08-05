# pi extension API — research for the herdr-subagents package

Research question: what can a pi extension do that we need, and how do the two
extensions we are replacing (`pi-subagents`, `pi-intercom`) do it?

This grounds three decisions for our pi package: register a `--agent` flag,
load agent definitions, and report a subagent's final message to its parent.

All paths cite the installed copy under `/usr/lib/node_modules/pi` (upstream
checkout mirrors it at `/home/agus/workspace/asermax/pi`) and the installed
extensions under `/home/agus/.pi/agent/npm/node_modules/`.

## 1. The pi extension API

An extension is a TypeScript module exporting a default factory
`function (pi: ExtensionAPI)`. The factory runs once at startup, before
`session_start`, before `resources_discover`, and before provider
registrations are flushed; if it is `async`, pi awaits it
(`docs/extensions.md:140-165`). Extensions are auto-discovered from
`~/.pi/agent/extensions/*.ts` (global), `.pi/extensions/*.ts` (project-local,
after trust), or shipped as pi packages declared in `package.json`:

```json
{ "pi": { "extensions": ["./src/index.ts"], "skills": ["./skills"], "prompts": ["./prompts"] } }
```

### 1.1 Register a CLI flag

```ts
pi.registerFlag(name: string, options: {
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
}): void;

pi.getFlag(name: string): boolean | string | undefined;
```

Type declaration at `packages/coding-agent/src/core/extensions/types.ts:1190-1203`.
The loader stores the flag and seeds its default at
`src/core/extensions/loader.ts:221-237`; `getFlag` reads from the shared
runtime only if the owning extension actually registered the name
(`loader.ts:238-242`).

Flow from the command line to `getFlag`:

1. `src/cli/args.ts:188-200` — any unknown `--name`, `--name=value`, or
   `--name value` is collected into `result.unknownFlags: Map<string, boolean | string>`.
2. `src/main.ts:611` passes `parsed.unknownFlags` as `extensionFlagValues` into
   session services.
3. `src/core/agent-session-services.ts:80-128` (`applyExtensionFlagValues`)
   reconciles each provided value against the registered flags: a boolean flag
   is set to `true` when present, a string flag takes its value, and anything
   not registered becomes an `Unknown option: --x` diagnostic. The result lands
   in `runtime.flagValues`, which is what `getFlag` reads.

So registration is purely declarative — you call `registerFlag` at startup, and
pi matches it against CLI args for you. You do not parse `process.argv`.

**Live examples.** `--plan` (`examples/extensions/plan-mode/index.ts:62-66`):

```ts
pi.registerFlag("plan", { description: "Start in plan mode (read-only exploration)", type: "boolean", default: false });
// later:
if (pi.getFlag("plan") === true) { planModeEnabled = true; }
```

`--fff-mode` and friends
(`node_modules/@ff-labs/pi-fff/src/index.ts`, flag declarations near the
"Flags / lifecycle" block): `type: "string"` with no default, resolved by hand
as flag → env → default:

```ts
let currentMode: FffMode =
  (pi.getFlag("fff-mode") as FffMode) ??
  (process.env.PI_FFF_MODE as FffMode) ??
  "tools-and-ui";
```

The other flags the brief names (`--mcp-config`, `--cc-plugins-update`) are
built into pi's own arg parser rather than extension flags; the extension
pattern above is the one we want for `--agent`.

### 1.2 Hook the end of an agent turn and read the final assistant message

Three events, declared at `types.ts:670-694`:

```ts
interface TurnEndEvent { type: "turn_end"; turnIndex: number; message: AgentMessage; toolResults: ToolResultMessage[]; }
interface AgentEndEvent { type: "agent_end"; messages: AgentMessage[]; }
// plus agent_settled — fires when pi will not auto-retry/compact/continue
```

- `turn_end` fires after every LLM response + its tool calls; `event.message`
  is that turn's assistant message (`docs/extensions.md:574-587`).
- `agent_end` fires when a low-level run ends; `event.messages` is the whole
  run. pi may still auto-retry, compact-and-retry, or run queued follow-ups.
- `agent_settled` fires once pi will not continue on its own — the right hook
  for "the subagent is done, ship its result" (`docs/extensions.md:558-572`).

To read the **final** assistant message of a run, the plan-mode example uses
`agent_end` and walks the run's messages (`plan-mode/index.ts`,
`agent_end` handler):

```ts
const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
const text = getTextContent(lastAssistant);  // join text content blocks
```

`pi-subagents` extracts the same thing via `getFinalOutput(messages)` in
`node_modules/pi-subagents/src/shared/utils.ts` — it scans backward for the
last assistant message with non-empty text, skipping error stops, and returns
its full text. That is the exact function to reuse for "report a subagent's
final message."

### 1.3 Inject or append system prompt content

`before_agent_start` fires after the user submits a prompt, before the agent
loop, and can return a replacement system prompt and/or an injected message
(`types.ts:657-668`, `docs/extensions.md:521-556`):

```ts
pi.on("before_agent_start", async (event, ctx) => {
  return {
    systemPrompt: event.systemPrompt + "\n\nExtra instructions…",
    message: { customType: "my-ext", content: "…", display: true },
  };
});
```

`event.systemPrompt` is the chained prompt (earlier handlers' changes
included); `event.systemPromptOptions` exposes the structured inputs pi used
(`customPrompt`, `selectedTools`, `toolSnippets`, `promptGuidelines`,
`appendSystemPrompt`, `cwd`, `contextFiles`, `skills`). For pure append-only
content, users also pass `--append-system-prompt`, which populates
`systemPromptOptions.appendSystemPrompt`.

### 1.4 Register skills, tools, and slash commands

- **Tools:** `pi.registerTool({ name, label, description, promptSnippet,
  promptGuidelines, parameters (typebox), async execute(toolCallId, params,
  signal, onUpdate, ctx), renderCall?, renderResult? })`
  (`docs/extensions.md:1350-1380`, full example in pi-fff's `ffgrep`/`fffind`).
- **Commands:** `pi.registerCommand("name", { description, handler: async
  (args, ctx) => {} })`. Same-named commands from multiple extensions get
  numeric suffixes `/name:1`, `/name:2` (`docs/extensions.md:1582-1596`).
- **Skills:** contribute skill directories either statically via
  `package.json` (`"pi": { "skills": ["./skills"] }`) or dynamically by
  handling `resources_discover` and returning `{ skillPaths: [...] }`
  (`types.ts:528-545`). pi-subagents ships its skill both ways
  (`pi-subagents/package.json` `pi.skills`).

### 1.5 Read environment variables and act at startup

`process.env.*` is ordinary Node. The extension factory body runs before the
first turn, so reading env there is the startup hook (pi-fff reads
`process.env.PI_FFF_MODE` at the top of the factory). The bash tool also
injects `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`,
`PI_REASONING_LEVEL` into the env of commands it runs
(`docs/extensions.md:2087-2101`) — useful if a subagent shells out and needs
to identify itself.

### 1.6 Push entries into the conversation asynchronously

Two distinct mechanisms (`docs/extensions.md:1388-1478`):

- `pi.sendMessage(message, options?)` injects a message that **participates in
  LLM context**. `options.triggerTurn: true` wakes an idle agent immediately;
  `options.deliverAs` is `"steer"` (default; lands between tool calls),
  `"followUp"` (after the run), or `"nextTurn"` (queued for next prompt). This
  is how an inbound intercom message becomes a turn in the recipient (see §3.3).
- `pi.appendEntry(customType, data?)` writes a **TUI-only** entry that is not
  sent to the LLM, rendered with `pi.registerEntryRenderer(customType,
  renderer)`. Use this for progress widgets, etc. pi-subagents'
background/async run status uses this style of durable entry plus a
`status.json`/`events.jsonl` sidecar under an async dir.
- `ctx.ui.setStatus(key, text)` writes a **footer status line** (the line above
  the input); `ctx.ui.setStatus(key, undefined)` clears it. `ctx.ui` is on the
  handler context (`pi.on(event, (e, ctx) => ctx.ui.setStatus(...))`), not on
  `pi` directly. herdr-subagents' parent role uses this to summarize every
  tracked child as one keyed line (`herdr-subagents`), recomputed on each
  status change and cleared when there are no children. See
  `examples/extensions/status-line.ts`.

## 2. pi-subagents

Source: `node_modules/pi-subagents/src/`. Entry `index.ts` →
`src/extension/index.ts`.

### 2.1 Agent discovery — directories, precedence, recursion

`discoverAgents(cwd, scope)` lives at
`src/agents/agents.ts:1646-1690`. It loads from four sources, then merges by
name with this precedence (lowest → highest, last write wins):
`builtin < package < user < project` (`src/agents/agent-selection.ts`,
`mergeAgentsForScope`, and `sourceRank` at `agents.ts:488`).

Directories (scope `both`, the default):

| Source | Directory |
|---|---|
| builtin | `<pkg>/agents` (`agents.ts:1628`) |
| package | per-installed-package `agents/` dirs under node_modules (`agents.ts:429-465`) |
| user | `~/.pi/agent/agents` (old) **and** `~/.agents` (new), plus `extraUserAgentDirs()` (`agents.ts:1647-1648`, `1637`) |
| project | `<projectRoot>/.pi/agents` (preferred) **and** `<projectRoot>/.agents` (legacy) (`resolveNearestProjectAgentDirs`, `agents.ts:1602-1624`) |

Config-dir name defaults to `.pi`
(`src/shared/utils.ts:DEFAULT_CONFIG_DIR_NAME`); `getProjectConfigDir(root)`
returns `<root>/.pi`, and `getAgentDir()` returns `$PI_CODING_AGENT_DIR` or
`~/.pi/agent`.

**Recursion:** yes. `loadAgentsFromDir` walks via `listFilesRecursive`
(`agents.ts:1413-1415`, `1370-1395`), which descends into subdirectories and
picks up every `*.md` (excluding `*.chain.md` and legacy `.agents/skills`
paths). It prunes only `.git`, `node_modules`, and nested project roots
(`DISCOVERY_PRUNED_DIR_NAMES` at `agents.ts:1353`,
`shouldPruneDiscoveryDir`). So `<project>/.pi/agents/**` is scanned
recursively, which is exactly why the pi-cc-plugins symlink into
`.pi/agents/cc-plugins/` is picked up. **For herdr-subagents this means an
agent file placed at `.pi/agents/herdr/*.md` will be discovered with source
`project`.**

Files require `name` and `description` frontmatter or they are skipped
(`agents.ts:1430-1433`).

### 2.2 Frontmatter schema

Parsed by `parseFrontmatter` (`src/agents/frontmatter.ts`) — a hand-rolled
YAML-subset parser (flat `key: value`, nested blocks, folded `>` scalars, and
list helpers). The full set of honoured fields is `KNOWN_FIELDS`
(`src/agents/agent-serializer.ts:4-37`); everything else is captured into
`AgentConfig.extraFields` and round-trips through serialize/deserialize.

Map to `AgentConfig` (`src/agents/agents.ts:1450-1565`,
`interface AgentConfig` at `agents.ts:116-160`):

| Field | Type | Effect |
|---|---|---|
| `name` | string (required) | Runtime name; combined with `package` via `buildRuntimeName` |
| `package` | string | Namespaces the runtime name (`pkg.agent`); parsed by `parsePackageName` |
| `description` | string (required) | Shown in the tool schema |
| `alias` / `aliases` | list | Alternate invocation names |
| `tools` | list | Comma/newline list; `mcp:`-prefixed entries split into `mcpDirectTools` |
| `model` | string | Model override for the child |
| `fallbackModels` | list | Tried in order if the primary model is unavailable |
| `thinking` | string \| `false` | Thinking suffix (`off|minimal|low|medium|high|xhigh|max`) or disabled |
| `systemPromptMode` | `replace` \| `append` | Becomes `--system-prompt` vs `--append-system-prompt` for the child |
| `inheritProjectContext` | bool | Child gets `--no-context-files` when false |
| `inheritSkills` | bool | Child gets `--no-skills` when false |
| `defaultContext` | `fork` \| `fresh` | Whether the child forks the parent's transcript |
| `async` | bool | Default to background run |
| `timeoutMs` | int | Per-attempt timeout |
| `turnBudget` | JSON `{maxTurns, graceTurns}` | Turn cap for the child |
| `acceptance` | YAML | Structured acceptance policy |
| `acceptanceRole` | `read-only` \| `writer` | Infers acceptance role |
| `skill` / `skills` | list | Skills made available to the child |
| `skillPath` | list | Extra skill search paths |
| `extensions` | list | Extra `--extension` paths for the child |
| `subagentOnlyExtensions` | list | Extensions only for fanout-authorized children |
| `output` | string | Default output file |
| `defaultReads` | list | Files the run should read up front |
| `defaultProgress` | bool | Stream progress |
| `interactive` | bool | Allow TUI clarification |
| `maxSubagentDepth` | int | Depth cap |
| `completionGuard` | bool | Require a completion guard |
| `toolBudget` | JSON `{soft, hard, block}` | Tool-call budget |
| `memory` | block | Agent memory config |

Defaults for `systemPromptMode`/`inheritProjectContext`/`inheritSkills` come
from per-agent heuristics (`defaultSystemPromptMode`,
`defaultInheritProjectContext`, `defaultInheritSkills`). Agent-level values can
also be overridden en masse by user/project settings JSON
(`agents.ts:1675-1690`, `applySubagentDefaults` + `applyCustomAgentOverrides`),
which is how `subagents.defaultModel` and per-agent overrides are applied
without editing the agent file.

### 2.3 Spawning and driving a child

**Subprocess, not in-process.** pi-subagents spawns a fresh `pi` process per
run (`src/runs/foreground/execution.ts:455-470`):

```ts
const spawnSpec = getPiSpawnCommand(args);     // src/runs/shared/pi-spawn.ts
const proc = spawn(spawnSpec.command, spawnSpec.args, {
  cwd: options.cwd ?? runtimeCwd,
  env: { ...process.env, ...sharedEnv, ...depthEnv },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
```

`getPiSpawnCommand` resolves the binary as `$PI_SUBAGENT_PI_BINARY`, else
`process.execPath` + the resolved pi CLI script, else `pi` on PATH
(`pi-spawn.ts:140-160`). The child's args are built by `buildPiArgs`
(`src/runs/shared/pi-args.ts:255-330`):

- `--session <file>` (resume) or `--no-session` + `--session-dir <dir>`.
- `--model <model[:thinking]>`.
- `--tools <csv>` / `--no-tools` from the resolved tool plan.
- `--no-extensions` plus one `--extension <path>` per extension, always
  including a prompt-runtime extension and (for fanout children) a fanout
  extension (`pi-args.ts:222-296`).
- `--no-context-files` / `--no-skills` per inheritance flags.
- `--system-prompt <tmpfile>` (replace mode) or `--append-system-prompt
  <tmpfile>` (append mode) — the agent's `systemPrompt` body is written to a
  0600 temp file (`pi-args.ts:298-305`).
- The task itself as a positional `Task: <task>`, or `@<tmpfile>` when it
  exceeds `TASK_ARG_LIMIT` (`pi-args.ts:307-316`).

**Result and progress come back over stdout**, which is a line-delimited JSON
event stream. The parent reads it with a bounded line reader
(`src/runs/shared/child-protocol.ts`, `createBoundedLineReader`, cap
`MAX_CHILD_PENDING_LINE_BYTES = 16 MiB`). Each line is parsed as an event
(`execution.ts:826-870`): `tool_execution_start`, `agent_end`,
`agent_settled`, watchdog status, etc. Assistant messages are pushed into
`result.messages`. On completion the final text is extracted with
`getFinalOutput(result.messages)` (`utils.ts`, §1.2). The same events are
tee'd to a `.jsonl` transcript and surfaced as live `tool_execution_update`
snapshots to the parent model.

**Background/async runs** are the same subprocess detached to disk: state
lives in an async dir as `status.json` + `events.jsonl` + an output log, read
back with `readStatus(asyncDir)` (`src/shared/utils.ts`). The parent tracks
them by id and can `status`/`stop`/`resume`/`steer`.

### 2.4 How agents are exposed to the model

A single tool named `subagent` is registered
(`src/extension/index.ts:404-458`):

```ts
pi.registerTool({
  name: "subagent",
  description: buildSubagentToolDescription(config),  // src/extension/tool-description.ts
  parameters: <typebox schema with agent, task, chain, tasks, async, cwd, …>,
  async execute(...) { /* resolve agent, build args, spawn, stream, return SingleResult | Details */ },
});
```

The discovered agent inventory (name + description + package + aliases) is
inlined into that one tool's `description` text (and the system prompt
snippet), so the model picks the agent by the `agent` string argument rather
than seeing one tool per agent. The full parameter schema (chain, parallel,
expand, worktree, acceptance, toolBudget, …) lives in
`src/extension/schemas.ts`.

## 3. pi-intercom

Source: `node_modules/pi-intercom/` (`index.ts`, `broker/`, `reply-tracker.ts`,
`types.ts`, `config.ts`).

### 3.1 Broker transport and framing

- **Transport:** a Unix domain socket at `~/.pi/agent/intercom/broker.sock`
  (`broker/paths.ts:51-66`, `getBrokerSocketPath`). Windows uses a named pipe,
  and can optionally switch to TCP on `127.0.0.1`
  (`shouldUseWindowsTcpTransport`). The intercom dir is `0700`, runtime files
  `0600` (`INTERCOM_DIR_MODE`/`INTERCOM_RUNTIME_FILE_MODE`).
- **Framing:** 4-byte big-endian length prefix + UTF-8 JSON payload
  (`broker/framing.ts:9-20`, `writeMessage`; reassembled by
  `createMessageReader`). Max frame `MAX_FRAME_BYTES = 1 MiB`.
- **Protocol:** a `ClientMessage | BrokerMessage` union
  (`types.ts`). Clients send `register`, `unregister`, `list`, `send`,
  `message_receipt`, `cancel_message`, `cancel_ask`, `presence`, and
  extension bus messages (`extension_publish`/`extension_state_commit`). The
  broker replies with `registered`, `sessions`, `message`, `presence_update`,
  `session_joined`/`session_left`, `delivered`/`delivery_failed`,
  `message_receipt`, `message_control`, and `extension_*`.
- **Lifecycle:** the broker is a separate process. The first client that
  cannot connect spawns it via `spawnBrokerIfNeeded(config.brokerCommand,
  config.brokerArgs)` (`broker/spawn.ts`), default `npx --no-install tsx`.
  Clients reconnect with backoff (`index.ts:1112-1166`).

### 3.2 Registration, addressing, and the session list

On connect, a session sends `{ type: "register", session: SessionRegistration,
sessionId?, stateId? }` (`types.ts`). `SessionRegistration` carries `name`,
`cwd`, `model`, `pid`, `startedAt`, `lastActivity`, `status`, and extension
capabilities (`types.ts`). pi-intercom builds it in `buildRegistration()`
(`index.ts:768-790`) — `name` comes from `buildPresenceIdentity`
(`index.ts:404-410`), which prefers `$PI_INTERCOM_STABLE_ID`, then
`config.stableId`, then the pi session id.

The broker assigns/reconciles an `id`, replies `{ type: "registered",
sessionId, features }`, and maintains the live roster; `list` returns it as
`SessionInfo[]` and every join/leave/presence heartbeat fans out as
`session_joined`/`session_left`/`presence_update`. **Addressing is by `id` or
by `name`** — the broker and the reply tracker both resolve name → session
case-insensitively (`reply-tracker.ts:8-14`, `matchesPendingSender`).

### 3.3 How an inbound message triggers a turn

When a `message` arrives, pi-intercom injects it with `pi.sendMessage` and a
delivery mode chosen from the `inboundTrigger` policy
(`config.ts:35-39`, default `"always"`):

```ts
// index.ts:858-898 (condensed)
function shouldTriggerInboundMessage(entry, force = false) {
  if (force) return true;
  if (config.inboundTrigger === "always") return true;
  if (config.inboundTrigger === "replies") return Boolean(entry.message.replyTo);
  return false;  // "never"
}
pi.sendMessage(
  { customType: "intercom_message", content: `**From ${sender}**…`, display: true, details: entry },
  delivery === "trigger" && shouldTriggerInboundMessage(entry, force)
    ? { triggerTurn: true }              // wakes an idle agent immediately
    : { deliverAs: "followUp" },         // otherwise queued after the current run
);
```

So the mechanism is exactly the §1.6 `sendMessage({ triggerTurn: true })` path.
`inboundTrigger` ∈ `{always, replies, never}` lets a recipient opt out of
auto-waking. The incoming message is also recorded with the `ReplyTracker`
(`index.ts:970-973`) so a later `reply`/`ask` can target it.

### 3.4 `contact_supervisor` — injected into child sessions only

The tool is registered conditionally
(`index.ts:1504-1510`):

```ts
const childOrchestratorMetadata = readChildOrchestratorMetadata();
const nativeSupervisorChannelAvailable = Boolean(process.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV]?.trim());
if (childOrchestratorMetadata && !nativeSupervisorChannelAvailable) {
  pi.registerTool({ name: "contact_supervisor", /* … */ });
}
```

`readChildOrchestratorMetadata()` (`index.ts:101-119`) returns non-null only
when the parent set all of:

- `PI_SUBAGENT_ORCHESTRATOR_TARGET` — the parent's intercom address.
- `PI_SUBAGENT_RUN_ID`, `PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_CHILD_INDEX`.
- optionally `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` (falls back to
  `PI_INTERCOM_SESSION_ID`) and `PI_SUBAGENT_INTERCOM_SESSION_NAME`.

These are exactly the env vars pi-subagents injects when it spawns a child
(`src/runs/shared/pi-args.ts:370-400`):
`SUBAGENT_ORCHESTRATOR_TARGET_ENV = input.orchestratorIntercomTarget`,
`SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV = input.parentSessionId`, plus the run
id, child agent name, and index. The orchestrator target itself is derived in
pi-subagents as `resolveIntercomSessionTarget(pi.getSessionName(),
sessionId)` (`src/intercom/intercom-bridge.ts:60-69`) — the parent's session
name, or `session-<id8>` as a fallback.

**Bridge metadata supplied to the child** (`src/intercom/intercom-bridge.ts`,
`applyIntercomBridgeToAgent`): when the bridge is active, the child agent's
`tools` gets `["intercom", "contact_supervisor"]` appended and its
`systemPrompt` gets a bridge instruction block telling it to use
`contact_supervisor({reason:"need_decision"|"interview_request"|"progress_update"})`
instead of asking in plain text. The bridge template is
`DEFAULT_INTERCOM_BRIDGE_TEMPLATE` (`intercom-bridge.ts:21-31`).

**Two supervisors, one tool name.** pi-subagents ships its own native
file-based supervisor channel (`NATIVE_INTERCOM_EXTENSION_DIR =
"native:pi-subagents-supervisor-channel"`, backed by a
`SUBAGENT_SUPERVISOR_CHANNEL_DIR` with `requests/` and `replies/`
subdirectories). When that native channel is present
(`SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV` set), pi-subagents provides
`contact_supervisor` itself and pi-intercom defers (the `!
nativeSupervisorChannelAvailable` guard). When only pi-intercom is loaded in
the child, pi-intercom provides `contact_supervisor` over its socket broker.
Either way the child sees the same tool and the same env-driven target.

### 3.5 `ask` semantics — blocking request-for-reply

`ask` sends a message with `expectsReply: true` and then blocks on a single
live `replyWaiter` until the recipient replies or the ask timeout fires
(`index.ts:2018-2085`, `waitForReply` at `578-617`):

```ts
questionId = randomUUID();
replyPromise = waitForReply(sendTo, questionId, signal, () => client.cancelAsk(questionId), …);
await client.send(sendTo, { messageId: questionId, text, expectsReply: true, /* … */ });
const reply = await replyPromise;   // resolved when a matching reply lands
```

- The recipient gets the message like any other (injected via §3.3) and the
  `ReplyTracker` records it as a pending ask (`reply-tracker.ts:18-24`).
- A reply is matched by `replyTo == questionId` (most precise), by `to` ==
  sender, or by the current turn context / sole pending ask
  (`reply-tracker.ts:46-87`, `resolveReplyTarget`).
- The waiter rejects after `getAskTimeoutMs()` (default 10 min,
  `$PI_INTERCOM_ASK_TIMEOUT_MS`, `config.ts:5-18`). Timeout does not cancel
  the delivered message — it just unblocks the asker.
- Cancellation propagates: aborting the tool call runs `client.cancelAsk`,
  which tells the broker to cancel the pending ask on the recipient side.

## 4. Implications for the herdr-subagents package

1. **`--agent` flag:** one `pi.registerFlag("agent", { type: "string" })` call
   in the factory; read with `pi.getFlag("agent")`. No `process.argv`
   parsing. Same shape as `--fff-mode`.
2. **Agent definitions:** drop markdown files under `.pi/agents/herdr/*.md`
   (or ship them in the package's `agents/`). Discovery is recursive and the
   frontmatter schema (§2.2) already covers model, tools, system prompt, and
   context inheritance — we inherit it for free. Files need `name` +
   `description`.
3. **Report the final message to the parent:** hook `agent_settled` (or
   `agent_end`), then `getFinalOutput(ctx.session messages)` — exactly what
   pi-subagents does. For the transport, see (4).
4. **Reuse vs replace pi-intercom's broker.** **Reuse.** The broker already
   solves the hard parts we would otherwise rebuild: a length-prefixed Unix
   socket with reconnection, name/id addressing, a live session roster,
   `inboundTrigger` to turn a message into a recipient turn, and a battle-tested
   `ask` with reply tracking and cancellation. The parent/child wiring is
   already specified by the env contract in §3.4 — if herdr-subagents sets
   `PI_SUBAGENT_ORCHESTRATOR_TARGET` + run/agent/index when it spawns a herdr
   tab, pi-intercom (or pi-subagents' native channel) will expose
   `contact_supervisor` in the child with zero extra code. What to **drop**:
   pi-intercom's interactive confirm-send, presence/context% heartbeats, and
   the extension-bus features are more than a focused report channel needs,
   but they are opt-in/idle and cost little to leave running. The one thing to
   evaluate is whether herdr's own pane addressing (e.g. `w1Y:p2`) should be
   the intercom `name` so the parent can target a tab directly — that is a
   config choice, not a protocol change.

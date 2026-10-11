// src/core/subagent.ts
var COMMANDS = [
  "spawn",
  "prompt",
  "wait",
  "collect",
  "list",
  "close",
  "read",
  "unblock"
];
function commandsFor(harness) {
  return harness === "pi" ? COMMANDS : COMMANDS.filter((command) => command !== "wait");
}
var OPTION_DESCRIPTIONS = {
  agent: "Agent name \u2014 the definition's system prompt is applied automatically (never a path)",
  label: "Tab label",
  model: "Model the child's harness runs; omitted, the harness default (spawn only)",
  body: "Prompt body wrapped in <supervisor-agent> \u2014 the initial prompt on spawn, the message on prompt",
  body_file: "Path to a file whose content is the prompt body \u2014 alternative to body (absolute, or relative to the cwd)",
  worktree: "Give the child its own git worktree (spawn only)",
  branch: "Worktree branch; an existing one is joined (spawn only)",
  base: "Ref a new worktree branch forks from (spawn only)",
  pane_id: "Pane id",
  tab_id: "Tab id",
  timeout: "Timeout in ms (wait only)",
  keys: 'Space-separated key names, e.g. "1 enter" (unblock only)',
  lines: "Screen lines to read (read only)"
};
function inputSchemaFor(harness) {
  const string = (description) => ({ type: "string", description });
  const number = (description) => ({ type: "number", description });
  const boolean = (description) => ({ type: "boolean", description });
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
          ...harness === "pi" ? { timeout: number(OPTION_DESCRIPTIONS.timeout) } : {},
          keys: string(OPTION_DESCRIPTIONS.keys),
          lines: number(OPTION_DESCRIPTIONS.lines)
        }
      }
    },
    required: ["command"]
  };
}
function buildHelperArgs(command, options) {
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
      if (options.timeout !== void 0) args.push("--timeout", String(options.timeout));
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
      if (options.lines !== void 0) args.push("--lines", String(options.lines));
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
function childName(...candidates) {
  return candidates.find((c) => c && c.length > 0) ?? "subagent";
}
function formatResult(command, options, json) {
  switch (command) {
    case "spawn": {
      const r = json;
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
      const r = json;
      const name = childName(options.label);
      if (r.timed_out) {
        return `Timed out waiting for subagent ${name} \u2014 nothing new; re-arm the wait`;
      }
      return `Subagent ${name} is ${r.status}`;
    }
    case "collect": {
      const r = json;
      const name = childName(r.label, r.agent, options.label);
      if (r.error) return `Subagent ${name} (${r.pane_id}) errored: ${r.error}`;
      if (r.ask) return `Subagent ${name} (${r.pane_id}) is asking:
${r.message ?? ""}`;
      if (r.message) return `Subagent ${name} (${r.pane_id}, ${r.status}):
${r.message}`;
      return `Subagent ${name} (${r.pane_id}) is ${r.status} with no message yet`;
    }
    case "list": {
      const r = json;
      if (!r.children || r.children.length === 0) return "No children tracked.";
      const lines = r.children.map(
        (c) => `  ${c.label || c.pane_id}: ${c.status} (pane_id ${c.pane_id}, tab_id ${c.tab_id})`
      );
      return `Fleet (${r.children.length}):
${lines.join("\n")}`;
    }
    case "close": {
      const name = childName(options.label);
      return `Closed subagent ${name}`;
    }
    case "read": {
      const r = json;
      const name = childName(options.label);
      return `Subagent ${name} is ${r.status}. Its pane:
${r.screen}`;
    }
    case "unblock": {
      const r = json;
      const name = childName(options.label);
      if (r.cleared) return `Unblocked subagent ${name}; it is now ${r.status}`;
      return `Subagent ${name} is still blocked after ${options.keys ?? "the keys"}. Its pane:
${r.screen ?? ""}`;
    }
  }
}
function formatError(command, options, json, stderr) {
  const detail = errorMessage(json) || stderr.trim() || "the subagent command exited with an error";
  let message;
  if (command === "spawn" && failureReason(json) === "delivery") {
    const paneId = stringField(json, "pane_id");
    const retry = paneId === void 0 ? "" : ` \u2014 retry with this tool's prompt command: { pane_id: "${paneId}", body: "<supervisor-agent>\u2026</supervisor-agent>" }`;
    message = `Subagent ${childName(options.label, options.agent)} spawned but its prompt was not delivered: ${detail}${retry}`;
  } else {
    const target = commandTarget(command, options);
    message = `Failed to ${command} ${target}: ${detail}`;
  }
  const screen = stringField(json, "screen");
  return screen === void 0 ? message : `${message}
The child's pane:
${screen}`;
}
function stringField(json, field) {
  if (typeof json !== "object" || json === null) return void 0;
  const value = json[field];
  return typeof value === "string" ? value : void 0;
}
function failureReason(json) {
  return stringField(json, "reason");
}
function errorMessage(json) {
  return stringField(json, "message");
}
function commandTarget(command, options) {
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
function missingOption(command, options) {
  switch (command) {
    case "spawn":
      return !options.kind ? "kind" : !options.label ? "label" : void 0;
    case "prompt":
      return !options.pane_id ? "pane_id" : options.body === void 0 && options.body_file === void 0 ? "body" : void 0;
    case "wait":
    case "collect":
    case "read":
      return !options.pane_id ? "pane_id" : void 0;
    case "close":
      return !options.tab_id ? "tab_id" : void 0;
    case "unblock":
      return !options.pane_id ? "pane_id" : !options.keys ? "keys" : void 0;
    case "list":
      return void 0;
  }
}
function parseHelperJson(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return void 0;
  try {
    return JSON.parse(trimmed);
  } catch {
    return void 0;
  }
}
async function runSubagent(command, options, run) {
  const missing = missingOption(command, options);
  if (missing !== void 0) {
    return { isError: true, text: `\`${missing}\` is required for \`${command}\`` };
  }
  let formatOptions = options;
  if (formatOptions.label === void 0 && command !== "spawn" && command !== "list") {
    const label = await resolveLabel(formatOptions, run);
    if (label) formatOptions = { ...formatOptions, label };
  }
  const output = await run(buildHelperArgs(command, options));
  if (output.exitCode === 0 && output.json !== void 0) {
    return { isError: false, text: formatResult(command, formatOptions, output.json) };
  }
  return { isError: true, text: formatError(command, formatOptions, output.json, output.stderr) };
}
async function resolveLabel(options, run) {
  const output = await run(["list"]);
  if (!output.json) return void 0;
  const result = output.json;
  for (const child of result.children) {
    if (options.pane_id && child.pane_id === options.pane_id) return child.label;
    if (options.tab_id && child.tab_id === options.tab_id) return child.label;
  }
  return void 0;
}
var SKILL_INVOCATION = {
  pi: "/skill:delegate",
  claude: "/delegate"
};
function promptGuidelines(harness) {
  return [
    "Use `subagent` to delegate separable work to a child agent running in its own herdr tab \u2014 one tab, one task.",
    '`spawn`: options `{ kind: "pi"|"claude", label: string, agent?: string, model?: string, body?: string, body_file?: string, worktree?: boolean, branch?: string, base?: string }`. `kind` is required and defaults to your own harness. `model` runs the child on a specific model; omitted, the harness\'s default applies \u2014 when you choose one, pick the cheapest model that can solve the task. Pass `body` (wrapped in `<supervisor-agent>\u2026</supervisor-agent>`) to send the task in the same call, or `body_file` with a path to a file whose content is the body (absolute, or relative to the cwd). Returns `{ pane_id, tab_id }` \u2014 keep both.',
    "`agent` (spawn only) runs the child under a named agent definition: the child's system prompt is set from the definition automatically, at spawn. Pass only the name \u2014 never a path, never the definition pasted into `body`, and never an instruction for the child to read the file." + (harness === "pi" ? " On pi, definitions are `.md` files under the project's `.pi/agents/`." : ""),
    "`prompt`: options `{ pane_id: string, body: string }` or `{ pane_id: string, body_file: string }`. Follow-up prompts to a spawned child. Wrap the body in `<supervisor-agent>\u2026</supervisor-agent>` so the child knows it is a supervisor directive.",
    "`collect`: options `{ pane_id: string }`. Returns the child's last message as a descriptive summary including status, message, and whether the child is asking a question (`ask`). A question means reply, do not close.",
    "`close`: options `{ tab_id: string }`. Close a child once you have its result and no longer need it.",
    "`list`: no options. Shows every tracked child and its status \u2014 the durable backstop for a missed wake.",
    ...harness === "pi" ? [
      "`wait`: options `{ pane_id: string, timeout?: number }`. Rarely needed \u2014 your session auto-wakes you when a child reaches a terminal state. The abort signal interrupts a stuck wait."
    ] : [],
    "`read`: options `{ pane_id: string, lines?: number }`. Shows a child's pane \u2014 what a `blocked` child is waiting on. On a blocked child, read the pane and tell the human what to answer and in which tab; you are woken again when it resumes.",
    '`unblock`: options `{ pane_id: string, keys: string }`. Sends key presses to answer the dialog a `blocked` child is stalled on, e.g. `keys: "enter"` or `keys: "1 enter"`. Use it ONLY when the human has explicitly told you to answer that dialog \u2014 never on your own judgement. Rejected unless the child really is blocked.',
    `Prefer breadth (several children at your level) over deep chains. Close children before spawning the next batch. Invoke \`${SKILL_INVOCATION[harness]}\` for the full protocol.`
  ];
}
function toolDescription(harness) {
  return [
    "Delegate work to child agents in herdr tabs.",
    `Pass \`command\` (${commandsFor(harness).join("|")}) and the relevant \`options\`.`,
    "Each command returns a descriptive summary of what happened."
  ].join(" ");
}

// src/core/fleet.ts
var STATUS_KEY = "herdr-subagents";
var WAKE_TYPE = "herdr-subagents:wake";
var WAKES = /* @__PURE__ */ new Set(["done", "gone", "blocked"]);
var TRANSITION_WAKES = [
  { from: "working", to: "idle" },
  { from: "blocked", to: "working" }
];
var REMOVED = /* @__PURE__ */ new Set(["gone", "closed"]);
function createParentRoleState() {
  return { children: /* @__PURE__ */ new Map() };
}
function renderStatusLine(children) {
  if (children.size === 0) return void 0;
  const ordered = [...children.values()].sort(
    (a, b) => a.pane_id < b.pane_id ? -1 : a.pane_id > b.pane_id ? 1 : 0
  );
  return [ordered.map((c) => `${c.label || c.pane_id}: ${c.status}`).join(" | ")];
}
function processLine(state, sink, sendWake, rawLine) {
  let rec;
  try {
    rec = JSON.parse(rawLine);
  } catch {
    return;
  }
  if (!rec.pane_id || !rec.status) return;
  const status = rec.status === "unknown" ? "gone" : rec.status;
  const prev = state.children.get(rec.pane_id);
  const child = {
    pane_id: rec.pane_id,
    label: rec.label ?? prev?.label ?? "",
    status
  };
  if (REMOVED.has(status)) {
    state.children.delete(rec.pane_id);
  } else {
    state.children.set(rec.pane_id, child);
  }
  sink?.setWidget(STATUS_KEY, renderStatusLine(state.children));
  const transitionWakes = TRANSITION_WAKES.some(
    (t) => t.to === status && prev?.status === t.from
  );
  if (!WAKES.has(status) && !transitionWakes) return;
  sendWake(
    { customType: WAKE_TYPE, content: wakeContent(child), display: true },
    { triggerTurn: true }
  );
}
function wakeContent(rec) {
  const name = rec.label ? `"${rec.label}"` : rec.pane_id;
  if (rec.status === "blocked") {
    return `Child ${name} is blocked on a dialog. Use the subagent tool \u2014 read, pane_id ${rec.pane_id} \u2014 to see what it is asking, then tell the human to answer it in that tab.`;
  }
  if (rec.status === "working") {
    return `Child ${name} is no longer blocked and is working again.`;
  }
  return `Child ${name} reached ${rec.status}. Use the subagent tool \u2014 collect, pane_id ${rec.pane_id} \u2014 to read its result.`;
}
function createLineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim() !== "") onLine(line);
    }
  };
}

// src/claude/mod/parent-role.ts
var RESTART_DELAY_MS = 2e3;
var createWakeQueue = (submit) => {
  let pending = [];
  let inFlight = false;
  const flush = async () => {
    if (inFlight || pending.length === 0) return;
    inFlight = true;
    const text = pending.join("\n");
    pending = [];
    try {
      await submit(text);
    } catch {
    } finally {
      inFlight = false;
      void flush();
    }
  };
  return (text) => {
    pending.push(text);
    void flush();
  };
};
var startParentRole = (host) => {
  const state = createParentRoleState();
  const wake = createWakeQueue(host.submit);
  const sink = {
    setWidget: (_key, content) => host.status(content?.join("\n"))
  };
  const sendWake = (message) => wake(message.content);
  let stopped = false;
  let restart;
  let current;
  const run = async () => {
    try {
      const onChunk = createLineSplitter((line) => processLine(state, sink, sendWake, line));
      current = host.watch()[Symbol.asyncIterator]();
      for (let next = await current.next(); !next.done; next = await current.next()) {
        if (next.value.stream === "stdout") onChunk(next.value.text);
      }
    } catch {
    }
    if (stopped) return;
    state.children.clear();
    sink.setWidget(STATUS_KEY, void 0);
    restart = host.after(RESTART_DELAY_MS, () => void run());
  };
  void run();
  return () => {
    stopped = true;
    restart?.cancel();
    void current?.return?.();
    host.status(void 0);
  };
};

// src/claude/mod/register.ts
var HELPER_TIMEOUT_MS = 10 * 60 * 1e3;
async function helperOf($) {
  return await $.env.get("HERDR_SUBAGENT_HELPER") || `${$.plugin.root}/bin/herdr-helper`;
}
async function devArgsOf($, e) {
  if (e.command !== "spawn" || e.options?.kind !== "claude") return [];
  const pluginDir = await $.env.get("HERDR_SUBAGENT_PLUGIN_DIR");
  return pluginDir ? ["--plugin-dir", pluginDir] : [];
}
function hostOf($, helper) {
  return {
    watch: () => $.process.spawn({ argv: [helper, "watch"] }),
    status: (text) => $.ui.status(text),
    submit: (text) => $.prompt.submit({ text }),
    after: (ms, fn) => $.clock.after(ms, fn)
  };
}
function register(on) {
  let toolName;
  let stopParentRole;
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    try {
      const registered = await $.tool.register({
        name: "subagent",
        description: [toolDescription("claude"), ...promptGuidelines("claude")].join("\n\n"),
        inputSchema: inputSchemaFor("claude"),
        // Not behind ToolSearch: the delegate skill expects the tool at hand.
        isDeferred: false
      });
      toolName = registered.tool;
    } catch (error) {
      $.ui.log(
        `herdr-subagents: the subagent tool is not available in this session (${error instanceof Error ? error.message : String(error)})`
      );
    }
    if (e.isInteractive && await $.env.get("HERDR_PANE_ID") && stopParentRole == null) {
      stopParentRole = startParentRole(hostOf($, await helperOf($)));
    }
    return started;
  });
  on("session.end", async (_$, e, next) => {
    stopParentRole?.();
    stopParentRole = void 0;
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
          timeoutMs: HELPER_TIMEOUT_MS
        });
        return { exitCode, stdout, stderr, json: parseHelperJson(stdout) };
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          json: void 0
        };
      }
    });
    return outcome.isError ? { deny: outcome.text } : { result: outcome.text };
  }).catch((_$, e, next) => next.called ? next(e) : { deny: "The subagent tool failed" });
}
export {
  register
};

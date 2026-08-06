# The helper is a tool on pi

On pi the parent drives delegation through a single LLM-callable tool — `subagent` — instead of shelling out to `herdr-helper` over bash. On claude, bash remains the only surface (claude has no extension tool API).

## Context

Before this decision, both harnesses used the same interface: the agent ran `herdr-helper <command>` over bash. The shared `protocol.md` taught bash invocations with `{{helper}}` tokens for the binary path. The pi extension registered lifecycle hooks and the parent-role watcher but no tools.

## Decision

Register one tool — `subagent` — on the pi extension via `pi.registerTool()`. The tool takes `command` (enum: spawn | prompt | wait | collect | list | close) and a flat `options` object. Its `execute` maps the params to helper CLI argv, spawns `herdr-helper` by absolute path, and returns the helper's JSON output. The tool's `promptGuidelines` describe each command's options; they are always visible in the system prompt when the tool is active.

This **replaces** bash on pi: the protocol's command-invocation sections are factored into a new `{{invoke}}` token that resolves to tool-call syntax on pi and bash syntax on claude. The protocol body keeps the semantic descriptions (what each command does, option meanings, return values) shared across harnesses.

### The `{{invoke}}` token

The token set grows from two to three:

| Token        | pi                                          | claude                                          |
| ------------ | ------------------------------------------- | ----------------------------------------------- |
| `{{wake}}`   | Auto-wake (extension runs `helper watch`)   | Arm a background `helper wait`                  |
| `{{helper}}` | Runtime path (consumed in wake fragment)    | Runtime path (consumed in invoke + wake)       |
| `{{invoke}}` | Tool-call reference (`subagent` tool)       | Bash command reference (`{{helper}}` commands) |

`{{invoke}}` is injected from per-harness fragments at `src/skills/delegate/invoke-{pi,claude}.md`, mirroring the existing `{{wake}}` fragment pattern. Coverage sources now include the wake and invoke fragments alongside `protocol.md`, because the fragments themselves carry `{{helper}}` references that must be covered.

### Why the model provides the `<supervisor-agent>` tag

The tool does not auto-wrap the prompt body. The tag is a protocol-level concern: the child reads it to distinguish supervisor directives from human steering, and the model must understand the tagging to interpret collected messages correctly (the `<subagent-ask>` discriminator depends on the same tag vocabulary). Hiding the tag inside the tool would sever that understanding.

### Naming tension

CONTEXT.md reserves "subagent" for the child's own self-view. The tool name `subagent` is a new sense — a tool name, not a synonym for child — that coexists with the reserved usage. The glossary is updated to acknowledge this.

## Considered options

- **Discriminated-union options** (per-command option shapes). More type-safe, but union schemas are harder for some models to fill correctly. A flat object with optional fields is simpler and the `promptGuidelines` document which fields each command needs.

- **Auto-wrap `<supervisor-agent>` in the tool.** Rejected: the tag is protocol-level, not implementation-level. See above.

- **Keep bash as a fallback on pi.** Rejected: two interfaces for the same operation is confusing. The tool is the single surface; the helper binary still exists for the extension's own `watch` spawn.

## Consequences

- The protocol is invocation-neutral: command semantics are shared, invocation syntax diverges per harness via `{{invoke}}`.
- The token contract grows by one (`{{invoke}}`), and coverage sources grow to include the per-harness invoke and wake fragments.
- `watch` is excluded from the tool — the extension runs `helper watch` via parent-role.ts; exposing it would conflict.
- The `subagent` tool is registered unconditionally (parents and children both delegate).

# herdr-subagents

A Claude Code plugin and a pi package, built from one source, that let a coding agent delegate work by spawning other agents as herdr tabs.

## Language

### Roles

**parent**:
The agent that delegates. Exchanges are parent-driven: the parent owns spawning, labelling, prompting, collecting, and closing. A child's one active move is to end its turn with a question; it never initiates a message.
_Avoid_: spawner, supervisor (supervisor survives only in the `<supervisor-agent>` tag name).

**child**:
The agent a parent spawned. Used in code, docs, and the parent's voice. The child is parent-agnostic — it knows it is a child and knows its own pane, never its parent's identity.
_Avoid_: spawning child as a synonym for a different concept; do not swap child and subagent freely.

**subagent**:
Reserved for the child's own self-view (its onboarding voice) and for names that already contain the word (`HERDR_SUBAGENT`, the package names). Not a generic synonym for child.
_Avoid_: using subagent where child is meant.

**human**:
The person watching the fleet who can focus any tab and type into it. The recovery path for anything the parent cannot act on.

**harness**:
The agent runtime a child runs: pi or claude. Carried by the `--kind` flag.
_Avoid_: runtime, backend.

### The delegation surface

**delegation**:
A parent spawning a child to do separable work. One tab, one task.

**the helper**:
The CLI that wraps herdr for the delegation lifecycle (`spawn`, `prompt`, `wait`, `collect`, `list`, `close`, `watch`). Invoked over bash; the complete interface to delegation.
_Avoid_: the primitive, the tool, the wrapper.

**the gate**:
`HERDR_SUBAGENT=1`, the environment variable whose presence means "this session is a child". Implementation-only: a contract between the helper (which sets it) and the injection hook (which senses it). It appears in no agent-facing file.
_Avoid_: marker, tag. The gate is not agent-facing; the tags are.

**tag**:
One of the two agent-facing markers, `<supervisor-agent>` and `<subagent-ask>`. What the parent and child wrap their messages in.
_Avoid_: marker.

`<supervisor-agent>…</supervisor-agent>`:
The parent's prompts. A tagged message is a supervisor directive; an untagged message reaching a child means the human is steering it.

`<subagent-ask>…</subagent-ask>`:
The child's question. A child that needs a decision ends its turn with the question wrapped in this tag. It is the collect-time discriminator: wrapped means a question to reply to, unwrapped means the child's result.

**wake**:
The signal that a child reached a terminal state (`done` or `gone`). Always wake-then-collect: the wake never carries the result. One-shot per terminal state.
_Avoid_: notification, push (push implies a payload; the wake carries none).

**collect**:
Reading a child's last assistant message and returning it as a structured payload. Entirely parent-side; the child does nothing for it.
_Avoid_: read, fetch.

**token**:
A build substitution placeholder in the shared skill source, replaced per harness at build time. Exactly two exist: `{{wake}}` (the content divergence for how a parent is woken) and the helper path (resolved per artifact root). The build errors on any unknown token.

**wake-then-collect**:
The protocol shape: a wake brings the parent back; the parent then runs collect deliberately. The wake and the payload are deliberately separate so a burst of finishing children cannot flood the parent's context.

### Tracking and view

**the registry**:
The helper's record of the children a parent has spawned, keyed on `pane_id`. The anti-forget mechanism: `helper list` surfaces it on demand, so a missed wake never loses a child.

**the fleet**:
A parent's tracked children, and the human's view of the same as labelled tabs in one workspace. One sidebar reads as the whole fleet.

**onboarding**:
Injected content that tells a child it is a child, how to ask its parent, the tag rule, and that it may delegate. Static, present every turn; never a skill the child invokes.

**engaged**:
A child a human has focused. An engaged child is disqualified from being closed by its parent.

### herdr-native terms this project builds on

**pane**:
A single interactive terminal in herdr. Identified by `pane_id` (for example `w1Y:p6`). Addressable: a valid agent target.

**tab**:
A herdr tab holding one pane. Identified by `tab_id`; also has a label and a number. Not addressable as an agent target — closing is id-only.

**workspace**:
A herdr workspace holding tabs. Identified by `workspace_id`. Children live in the parent's workspace so one sidebar is the fleet.

**pane_id**:
The addressable id of a pane. Resolves as an agent target. Does not survive a herdr restart.

**tab label**:
The human-readable title of a tab, set by the parent at creation and final. For reading the sidebar; not addressable.
_Avoid_: treating the label as an identifier.

**agent status**:
herdr's state for a pane's agent: `idle | working | blocked | done | unknown`. Push, not polled — streamed via `pane.agent_status_changed`.

**done**:
A herdr agent status meaning the agent finished a turn, unacknowledged. Derived by herdr from a non-idle → idle transition. Reflects herdr state, not task success: a child that gives up still reaches `done`.
_Avoid_: reading `done` as "the work succeeded".

**blocked**:
A herdr agent status meaning the agent is stalled, often a tool-approval prompt waiting on the human. Non-terminal and benign; the parent leaves a blocked child alone.

**session log**:
The agent's own structured transcript, recorded by herdr as `agent_session` (a `.jsonl` path on pi, a session uuid on claude). The reliable content source for collect; screen reads are not.

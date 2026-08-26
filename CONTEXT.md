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
Reserved for the child's own self-view (its onboarding voice), for names that already contain the word (`HERDR_SUBAGENT`, the package names), and for the pi tool that wraps the helper. Not a generic synonym for child.
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
The CLI that wraps herdr for the delegation lifecycle (`spawn`, `prompt`, `wait`, `collect`, `list`, `close`, `watch`). On claude it is the complete interface to delegation, invoked over bash. On pi it is wrapped by the `subagent` tool — the model calls the tool, the tool spawns the helper.
_Avoid_: the primitive, the wrapper.

**the tool**:
The `subagent` tool on pi — a single LLM-callable tool that wraps the full helper surface. Takes `command` (spawn|prompt|wait|collect|list|close) and a flat `options` object. Registered by the pi extension; replaces bash helper calls on pi. Claude has no equivalent and uses the helper over bash.

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
A build substitution placeholder in the shared skill source, replaced per harness at build time. Exactly three exist: `{{wake}}` (the content divergence for how a parent is woken), `{{helper}}` (the helper's absolute path, resolved per artifact root at build time), and `{{invoke}}` (the content divergence for how commands are invoked — the `subagent` tool on pi, bash on claude). The build errors on any unknown token.

**wake-then-collect**:
The protocol shape: a wake brings the parent back; the parent then runs collect deliberately. The wake and the payload are deliberately separate so a burst of finishing children cannot flood the parent's context.

### Tracking and view

**the registry**:
The helper's record of the children a parent has spawned, keyed on `pane_id`. The anti-forget mechanism: `helper list` surfaces it on demand, so a missed wake never loses a child.

**the fleet**:
A parent's tracked children, and the human's view of the same as labelled tabs in one workspace. One sidebar reads as the whole fleet.

**onboarding**:
Injected content that tells a child it is a child, how to ask its parent, the tag rule, and that it may delegate. Static, present every turn; never a skill the child invokes.

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
herdr's state for a pane's agent: `idle | working | blocked | done | unknown`. Push, not polled — streamed via `pane.agent_status_changed`. The event carries the status but NOT `state_change_seq`; only `agent.get` reports the sequence, so anything reasoning about which state is new probes for it.

**done**:
A herdr agent status meaning the agent finished a turn, unacknowledged. Derived by herdr from a non-idle → idle transition. Reflects herdr state, not task success: a child that gives up still reaches `done`.
_Avoid_: reading `done` as "the work succeeded".

**idle**:
A herdr agent status meaning the agent is ready for input. `done` and `idle` are the SAME underlying state: `done` is the unacknowledged variant, `idle` the one whose tab has been seen in the focused herdr UI. So a finished turn presents as either, depending on whether anyone looked — a wake must treat both as the end of a turn.
_Avoid_: reading `idle` as "never worked" — after a prompt it means the turn ended.

**acked seq**:
The last `state_change_seq` the parent has been told about for a child, held in the registry with the status at that sequence. `prompt` acks the delivery receipt, `collect` acks the state it read, and `wait` acks what it reported; `wait` uses it as its baseline, so a state that arrives before the wait is armed still counts as new. The acked status matters in one case: a parent last told `blocked` is also woken when the child resumes. See ADR-0008.

**wake**:
What brings the parent back to a child: a finished turn (`done`, or an `idle` that ends one), a `blocked` dialog, the resume from one, or a lost child (`gone`). On claude it is a `wait` the parent arms per prompt; on pi the extension forwards it from `watch`. Never lost to a missed event — the state reported is probed, not inferred from the stream.

**blocked**:
A herdr agent status meaning herdr recognised a dialog on the agent's screen — a tool approval, a startup trust prompt. Non-terminal and benign: the child is alive and answerable. The parent can `read` the pane and `unblock` it with key presses, or hand it to the human; it never closes a blocked child.
_Avoid_: reading `blocked` as a dead or broken child.

**startup block**:
A child blocked before it ever became interactive — herdr answers `agent_start` with `agent_not_ready` and keeps the pane and the agent name. spawn reports it as a `blocked` failure and keeps the tab, unlike every other spawn failure. See ADR-0007.

**session log**:
The agent's own structured transcript, recorded by herdr as `agent_session` (a `.jsonl` path on pi, a session uuid on claude). The reliable content source for collect; screen reads are not.

# A blocked child is kept, and surfaced to the human

A child herdr reports as `blocked` is never closed by the helper. The parent gets two commands for it — `read` (show the pane) and `unblock` (send key presses, then verify the block cleared) — but only the first is its own to use: **the answer belongs to the human.** The parent reads the dialog, tells the human what it asks and which tab to answer it in, and is woken again when the child resumes (ADR-0008). `unblock` is for when the human has explicitly said to answer it — "yes, accept that prompt" — which saves them a tab switch without moving the decision.

This overrides the spawn rule that every exhausted bound closes the half-created tab. `blocked` is not an exhausted bound — it is a running, detected, correctly-named child sitting on a dialog. herdr says so explicitly: `agent start` answers `agent_not_ready` for it and keeps the name available for `agent read` and `agent send-keys`, and its guidance is to wait for idle rather than treat the pane as dead.

The helper used to fold `agent_not_ready` into the `fast-fail` bucket with every other non-timeout error, report it as `harness started and exited`, and then close the tab. Observed on claude children whose cwd had not been trusted yet: the message named a failure that had not happened, and the cleanup destroyed both the live child and the dialog that explained it. A spawn of five children in a fresh worktree lost one to a keypress nobody was allowed to send.

## The shape

- `startWithReadiness` classifies `agent_not_ready` as its own `blocked` readiness outcome, distinct from `timeout` (never came up) and `fast-fail` (came up and exited).
- spawn then gives the child `startupBlockedMs` to clear on its own — a transient boot screen does, a real dialog does not — and on expiry throws a `blocked` failure carrying `pane_id`, `tab_id`, and the pane's screen. That failure alone skips the cleanup: the tab stays open and the registry entry stays, so the watch keeps streaming the child and `list` keeps showing it.
- `unblock` gates on the pane's status: keys only ever reach a pane herdr reports `blocked`. Keys sent to an idle child are typed into its prompt box, which silently corrupts its next prompt.
- herdr owns the key-name vocabulary. It rejects an unsupported name with `invalid_key` and sends nothing, so the helper keeps no key list of its own.

## Considered options

- **Keep the tab but report `fast-fail`.** Rejected: the reason string is what the parent acts on, and "started and exited" points at a dead child. The two cases need different names because they need different responses.
- **Answer startup dialogs automatically inside spawn.** Rejected: the helper cannot tell a trust prompt from an approval that grants the child something the human never agreed to.
- **Let the parent answer any dialog it can read.** Rejected: a permission prompt is a decision about what the child may do to the machine, and a question the child opened is a question for a person. The parent cannot hold either mandate, and a dialog answered by the parent is indistinguishable to the child from one answered by the human — so the parent escalates by default and only ever answers on an explicit instruction.
- **Wait out the block for the full readiness timeout.** Rejected: a dialog never clears on its own, so a long wait only delays handing the pane over.

## Consequences

- A `blocked` spawn is a live child, so the parent has three moves — surface it to the human, `close` it, or answer it if the human says to — and the helper picks none of them.
- The parent gains its first screen read. `read` is scoped to that: the protocol points it at blocked children and keeps the session log as the source for results (ADR-0002).
- The human stays the one who answers, but stops being the one who has to *notice*: the parent watches, reports, and confirms the resume.
- A blocked child left unanswered stays in the fleet as an open tab. That matches the existing rule for a stalled child: surface it, do not kill it.

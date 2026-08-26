# A wake is any state a prompted child stops working in

The parent is woken when a child it prompted stops working — `done`, `idle`, `blocked`, or `gone` — measured against the last sequence the parent was told about, not against the moment the wake was armed.

Two missed-wake bugs forced this. Both left a finished child sitting in its tab with nobody coming back for it, which reads to the human as "the fleet silently stopped working".

## The standing state emits no event

`wait` (the claude wake: a background `helper wait <pane_id>` the parent arms after prompting) captured the pane's `state_change_seq` at arm time and filtered anything at or below it, so herdr's lingering `done` from an earlier turn could not resolve it. But a turn that finishes *between* the prompt and the arming of the wait leaves the child standing in `done` — the transition already happened, no further event is coming, and the baseline captured at arm time is that very `done`. The wait then hung to its timeout. Reproduced end to end: prompt at seq 84 → `done` at 85 → a wait armed afterwards timed out at 8s with the child finished and unread.

The fix is a baseline the parent owns rather than one read at arm time: `acked_seq` in the registry, written by `prompt` (from the delivery receipt) and by `collect` (the state it read). `wait` probes the current state first and answers from it when it is newer than `acked_seq`; only a still-working child gets a subscription. A delivery receipt that already shows the child stopped working is deliberately NOT acked — that end-of-turn is a wake the parent has not had yet.

## A finished turn is not always `done`

`done` and `idle` are the same underlying herdr state; `done` is the unacknowledged variant, and a tab that has been seen in the focused herdr UI reports `idle` instead. Both wake paths matched on `done` alone, so whether a completion reached the parent depended on whether anyone had looked at the child's tab. Observed live: a child holding `done` at seq 87 decayed to `idle` at the same seq, with no new sequence and nothing further to match on.

So `wait` matches `done | idle | blocked | unknown` — every state except `working` — and the pi parent role wakes on an `idle` whose previous status was `working`. The seq baseline is what keeps `idle` from firing on a fresh child settling, or on an acknowledged `done` decaying; on the pi side, where there is no seq, the previous status does the same job.

## Sequences come from `agent.get`, not from events

Verified against herdr 0.8.x while building this: a `pane.agent_status_changed` event carries `{ pane_id, workspace_id, agent, agent_status }` and no `state_change_seq`, and subscribing replays no status history. The client-side stale filter in `waitForStatusOverSocket` therefore only ever fired against the test stub, which does send sequences.

That is why every sequence in this design is probed rather than read off an event: `wait` probes before subscribing, and the prompt receipt probes once delivery is confirmed. The probe is also more useful than the event it replaces — it reports where the child stands *now*, so a turn that ended inside the delivery window is visible immediately.

## Blocked wakes, and the resume

`blocked` never woke the parent. Now it does — and so does the transition *out* of it: `working` right after a `blocked` the parent was told about. That pair is what lets the parent own the whole exchange without watching a tab: it learns the child is stuck, tells the human what to answer and where, and learns when they have.

`working` is a wake in that one case only. Everywhere else it is the child doing its job, and the sequence baseline (on claude) or the previous status (on pi) is what distinguishes the two.

## No wake can be lost

Three mechanisms, each covering a failure the others do not:

- **The probe before the wait.** A state that landed before the subscription opened is read, not awaited.
- **Dedupe on `(status, sequence)`.** `watch` deduped on status alone, so two consecutive `done`s — two finished turns — emitted once. The sequence comes from a probe, since events carry none.
- **A re-probe floor under the event stream.** A subscription can stop delivering without closing, and nothing downstream would notice. `wait` therefore never trusts the stream for more than 60 seconds at a stretch, and `watch`'s 30-second safety pass now re-reads every live child and emits any difference. Events stay the fast path; the probe is the guarantee.

And the channel itself no longer dies quietly: a `wait` that runs out of budget exits 0 with `timed_out: true` and the current status — "nothing yet, re-arm" — instead of exiting 1 with `wait_timeout`, which on claude looked like a failed background task.

## Considered options

- **Poll the child's status from the parent.** Rejected for the same reason ADR-0005 rejected polling: latency on every wake, and the parent would have to hold a loop it cannot hold across turns.
- **Have `wait` return on any standing `done`, with no baseline.** Rejected: a `done` the parent already collected would resolve instantly, so every re-armed wait would fire immediately and spin the parent.
- **Keep `blocked` silent and let the fleet widget carry it.** Rejected: the widget is a pi surface and a passive one. On claude there is no widget at all, and a blocked child stalls forever.
- **Wake on every `working`.** Rejected: the parent would be woken on every turn start for no decision. The resume is a wake because of what preceded it, not because of what it is.
- **Debounce `blocked` before waking.** Considered against detection flap (a screen whose text looks like a dialog). Rejected for now: herdr's working-state rules outrank the blocked rules in its manifest, so a mid-turn flap is unlikely, and the protocol already tells the parent to read the pane before answering — which self-corrects a spurious wake at the cost of one turn.

## Consequences

- `prompt` now reports the state the child moved to on delivery, so a parent that prompted a child which finished inside the delivery window can collect without waiting at all.
- `wait` answers immediately for a child that is already finished, already blocked, or gone; only a working child holds the subscription open.
- A pane whose agent no longer resolves ends the wait as `gone` instead of hanging, confirmed with a second probe so a transient detection gap is not reported as a dead child.
- `blocked` wakes on both harnesses. A parent driving children whose harness prompts for tool approvals will be woken by those prompts; that is the intended cost of never stalling silently. It escalates them rather than answering them (ADR-0007).
- The parent must re-arm `wait` after every wake — including a `timed_out` one. `list` remains the durable backstop if it ever fails to.

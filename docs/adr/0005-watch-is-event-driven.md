# Watch is event-driven, not polled

`helper watch` streams child-status changes from herdr event subscriptions — a per-pane `pane.agent_status_changed` socket for status, a shared `pane.created` subscription for discovery, and a shared `tab.closed` subscription for closure — and emits one JSON line per change. It does not poll. This replaces the 2s `agent.get` poll loop added in `ee969c9`, which itself replaced an earlier event-driven watch that crashed on real herdr.

That earlier watch multiplexed many `events.subscribe` calls on one connection. herdr allows only one subscribe per connection (any other request resets it), and one stale pane in a multi-pane subscribe fails the whole batch — so the first stale registry entry killed the entire fleet stream on startup. The poll was a robust regression, not a design choice.

## Why event-driven works now

Verified against herdr 0.8.0; these behaviors shape the design:

- **One connection per child**, one `pane.agent_status_changed` subscribe each. A stale/gone pane resets only its own (never-acked) connection; the rest of the fleet stream survives.
- **The baseline status uses a separate one-shot `agent.get`**, not the subscription socket — any other request on a subscription socket resets it.
- **Closure comes from `tab.closed`** (emitted as `tab_closed`, carries `tab_id`), correlated against the registry: child already removed → `closed`; still tracked → `gone`. Closing a tab does NOT close the status socket and does NOT emit `pane.closed` / `pane.exited` — only `tab.closed`.
- **A dead harness whose tab stays open** surfaces on the status subscription as `unknown`; the parent-role consumer normalizes `unknown → gone`. No liveness probe is needed.
- **Discovery comes from `pane.created`** (emitted as `pane_created`). spawn writes the registry right after `tabCreate` (before `agentStart`), so a debounced reconcile on `pane_created` finds the child already tracked.

`helper close` removes the registry entry before closing the tab, so the `tab_closed` correlate reads `closed` deterministically (no spurious wake).

## Considered options

- **Poll `agent.get` (the `ee969c9` design).** Robust, but adds up to one poll interval of latency to every status change and, critically, to the terminal-state wake. Rejected: events give instant status and instant wakes.
- **Multiplex subscribes on one connection (the pre-`ee969c9` design).** Rejected: one stale pane kills the whole stream.
- **Event-driven status plus a periodic liveness probe for closure.** Considered when closure events looked absent; rejected once `tab.closed` (and `unknown` for dead-panes) were verified — no probe is needed.

## Consequences

- Status changes and terminal-state wakes reach the parent with ~instant latency instead of up to one poll interval.
- One socket per child plus one fleet socket; a slow safety reconcile (default 30s) reopens any subscription lost to a transient socket drop or a missed `pane.created`. It is a discovery backstop, not a status or liveness poll.
- `pane.created`, `tab.closed`, and `pane.exited` each replay a history flood on subscribe; the debounced reconcile and `tab_id` correlation absorb it.
- The output contract (`{ pane_id, label, status }` lines, with `gone` / `closed`) is unchanged, so the parent-role consumer (`processLine` → widget + wake) and its tests are untouched. See ADR-0004.

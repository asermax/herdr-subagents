# Fleet status is a widget above the input, not per-child cards

The parent surfaces every tracked child's state as ONE status widget above the input via `ctx.ui.setWidget("herdr-subagents", [text])` — a compact summary such as `cleaner: working | reviewer: done`, ordered by pane id. The widget is recomputed on every status change and cleared (`setWidget(key, undefined)`) when there are no tracked children. `gone` (detection lost) drops a child from the summary; the wake still fires.

We rejected the earlier design of one TUI status card per child via `pi.appendEntry` + `pi.registerEntryRenderer`. Cards were per-child entries that accumulated and never summarized: a parent with several children saw scattered cards, each naming one child, with no at-a-glance fleet view, and the card surface had no natural "empty" state. A single keyed widget gives the whole fleet in one glance, lives in a standard pi surface (`ctx.ui.setWidget`), and clears cleanly when the fleet is empty.

## Consequences

- The parent's watch callback runs outside a handler and so has no `ctx`; it captures `ctx.ui` once at `session_start` and reuses that sink for the session.
- `gone` is the only watch-driven removal. `helper watch` is event-driven (ADR-0005): a `tab.closed` for a tracked child still in the registry emits `gone` (a crash, or a close outside `helper close`); a dead harness whose tab stays open surfaces as `unknown` on the status subscription, which the consumer normalizes to `gone`. A child the parent closed via `helper close` is removed from the registry first, so its `tab.closed` reads `closed` (no wake) and it drops from the widget silently. The widget is a live summary, not a durable registry view — `helper list` remains the durable backstop.
- The terminal-state wake (`pi.sendMessage` with `triggerTurn`) is unchanged and separate from the status line.

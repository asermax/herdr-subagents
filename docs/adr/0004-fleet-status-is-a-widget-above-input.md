# Fleet status is a widget above the input, not per-child cards

The parent surfaces every tracked child's state as ONE status widget above the input via `ctx.ui.setWidget("herdr-subagents", [text])` — a compact summary such as `cleaner: working | reviewer: done`, ordered by pane id. The widget is recomputed on every status change and cleared (`setWidget(key, undefined)`) when there are no tracked children. `gone` (detection lost) drops a child from the summary; the wake still fires.

We rejected the earlier design of one TUI status card per child via `pi.appendEntry` + `pi.registerEntryRenderer`. Cards were per-child entries that accumulated and never summarized: a parent with several children saw scattered cards, each naming one child, with no at-a-glance fleet view, and the card surface had no natural "empty" state. A single keyed widget gives the whole fleet in one glance, lives in a standard pi surface (`ctx.ui.setWidget`), and clears cleanly when the fleet is empty.

## Consequences

- The parent's watch callback runs outside a handler and so has no `ctx`; it captures `ctx.ui` once at `session_start` and reuses that sink for the session.
- `gone` is the only watch-driven removal. `helper watch` polls each tracked child's `agent.get` and emits a `gone` when a pane no longer resolves (crash, or a herdr restart that renumbered it). A child the parent closed via `helper close` is removed from the registry first, so it drops from the widget immediately with no `gone`. The widget is a live summary, not a durable registry view — `helper list` remains the durable backstop.
- The terminal-state wake (`pi.sendMessage` with `triggerTurn`) is unchanged and separate from the status line.

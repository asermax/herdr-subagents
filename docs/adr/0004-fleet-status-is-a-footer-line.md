# Fleet status is a footer status line, not per-child cards

The parent surfaces every tracked child's state as ONE footer status line (the line above the input) via `ctx.ui.setStatus("herdr-subagents", text)` — a compact summary such as `cleaner: working | reviewer: done`, ordered by pane id. The line is recomputed on every status change and cleared (`setStatus(key, undefined)`) when there are no tracked children. `gone` (detection lost) drops a child from the summary; the wake still fires.

We rejected the earlier design of one TUI status card per child via `pi.appendEntry` + `pi.registerEntryRenderer`. Cards were per-child entries that accumulated and never summarized: a parent with several children saw scattered cards, each naming one child, with no at-a-glance fleet view, and the card surface had no natural "empty" state. A single keyed footer line gives the whole fleet in one glance, lives in a standard pi surface (`ctx.ui.setStatus`), and clears cleanly when the fleet is empty.

## Consequences

- The parent's watch callback runs outside a handler and so has no `ctx`; it captures `ctx.ui` once at `session_start` and reuses that sink for the session.
- `gone` is the only stream-driven removal: a collected-and-closed child lingers at its last status (`done`) until it goes `gone`, because `helper watch` goes quiet on `pane.closed` rather than emitting a removal. The footer line is a live summary, not a durable registry view — `helper list` remains the durable backstop.
- The terminal-state wake (`pi.sendMessage` with `triggerTurn`) is unchanged and separate from the status line.

After you prompt a child, arm the wake by launching `{{helper}} wait <pane_id>` as a background task. Claude does not auto-wake you on a child's completion — the background task's completion reminder is what brings you back. Re-arm it each time you prompt, including when you reply to a `<subagent-ask>`, and after every wake below.

`wait` reports what to do next and never fails silently:

- `done` or `idle` — the turn ended: collect.
- `blocked` — the child is stalled on a dialog: `read` its pane and tell the human what to answer and in which tab. Re-arm; you are woken again when it resumes.
- `working` — the block cleared, the child is running again. Re-arm and wait for the turn.
- `gone` — the child is no longer there.
- `timed_out: true` — nothing new happened within the budget. Nothing is wrong; re-arm.

A turn that finishes before you arm the wake still reports immediately: you never lose a completion by arming late.

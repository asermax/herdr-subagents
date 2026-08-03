# Collection is entirely parent-side

The child does nothing to deliver its result. When a child reaches a terminal status, the parent's watcher wakes and the helper reads the child's own session log (`agent_session` — a `.jsonl` path on pi, a session uuid on claude), extracting the last assistant message. There is no child-side report hook, no `Stop`-hook handoff, no child-to-parent push.

This follows from ADR-0001: because a child is a real herdr pane, herdr already derives `done` and records the session log, so collection is reading state the child produces anyway. Building a child-to-parent report channel would reintroduce the broker the tabs decision deleted, and would couple spawn success to child→parent comms (a coupling we deliberately broke when we dropped the child-initiated `ready` gate).

## Consequences

- The child whose harness lacks our plugin still delivers its result: it reaches `done` vanilla, and the helper reads its session log. It loses protocol compliance (it ignores the tags), not the work.
- The child's `<subagent-ask>` question rides the same collect path up as a result does; the tag is the only discriminator between "reply to me" and "this is my result".
- `status` reflects herdr state, not task success. A child that gives up still reaches `done`; the parent judges the work by reading `message`.

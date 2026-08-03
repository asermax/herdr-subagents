# Children are herdr tabs, not subprocesses

A child is a foreground interactive pane running a real harness, created with `herdr agent start --kind <pi|claude>` in the parent's workspace. We rejected the `pi-subagents` model of a child as a hidden subprocess reachable only through a broker: a tab is visible in the sidebar with live agent state, the human can focus it and type into it at any moment, and both harnesses work in both directions. The cost is that spawn is a verify-and-repair sequence — `agent start` and `agent prompt` returning success is not evidence the child landed — but that cost is bounded and lives in the helper.

## Considered options

- **Subprocess (pi-subagents shape).** Hidden child, brokered comms, parent-only access, pi-only. Rejected: invisible while running, unusable on claude, and the broker is the thing we want to delete.

## Consequences

- The human-in-the-tab safety pattern exists at all: under a hard no-focus invariant, a focus event on a child's tab is a human, which is what disqualifies the child from being closed by its parent.
- Nesting works to any depth because a child is just another tab that can create tabs in its own workspace.
- Print mode and detached mode are both rejected: print exits and takes the tab with it; detached starts claude's own supervisor rather than a herdr pane.

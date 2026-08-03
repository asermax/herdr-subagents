# The child is parent-agnostic

A child knows it is a child (the gate is set) and knows its own pane. It never learns its parent's identity — not the parent's pane id, not a parent name, not a depth counter. The earlier `HERDR_SUBAGENT_PARENT_PANE` variable was dropped.

Nesting works to any depth because each parent tracks its own children in its own registry; no thread of parentage is passed down. The child asks its parent by ending its turn with `<subagent-ask>` and never addresses anything itself, so it needs no parent pointer to follow the protocol.

## Considered options

- **One known parent (`HERDR_SUBAGENT_PARENT_PANE`).** Gives the child an exact parent pointer. Rejected: it reintroduced a child→parent push primitive (`herdr agent prompt`) into onboarding, which is exactly the broker-shaped thing the design is removing, and it bought nothing the child actually needs.

## Consequences

- The back-channel needs no transport of its own: the question rides the collect path up and an ordinary tagged prompt down.
- A pane id baked into a system prompt would go stale across a herdr restart anyway, so parent-agnosticism also avoids handing the child an address that lies.

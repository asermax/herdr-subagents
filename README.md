# herdr-subagents

Delegate work by spawning other agents as herdr tabs. A Claude Code plugin that adds a `/delegate` skill and an onboarding hook, turning one session into a fleet of labelled child tabs — one tab, one task.

Children are real herdr tabs a human can see and steer. A child can delegate further; nesting works to any depth.

## Install

Add the marketplace, then install the plugin:

```
claude plugin marketplace add asermax/herdr-subagents
claude plugin install herdr-subagents@herdr-subagents
```

## Use

```
/delegate
```

The skill steps through spawning a child, prompting it, collecting its result, and closing the tab. Prefer breadth (several children at your level) over deep chains, and close a child before spawning the next.

Requires Claude Code and herdr. See the [repo](https://github.com/asermax/herdr-subagents) for the full protocol.

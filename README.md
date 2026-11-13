# herdr-subagents

Delegate work by spawning other agents as herdr tabs. A Claude Code plugin that adds a `subagent` tool, a `/delegate` skill and an onboarding hook, turning one session into a fleet of labelled child tabs — one tab, one task. The session shows the fleet on its status line and wakes you when a child finishes, asks, or gets stuck on a dialog.

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

Requires herdr and a Claude Code build that runs hooks modules (mods). See the [repo](https://github.com/asermax/herdr-subagents) for the full protocol.

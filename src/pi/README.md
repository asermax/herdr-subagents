# @asermax/pi-herdr-subagents

Delegate work by spawning other agents as herdr tabs. A pi extension and skill that turn one session into a fleet of labelled child tabs — one tab, one task.

Children are real herdr tabs a human can see and steer. A child can delegate further; nesting works to any depth.

## Install

```
pi install npm:@asermax/pi-herdr-subagents
```

The package registers a `delegate` skill and an extension. The extension shows fleet status; the bundled `herdr-helper` binary handles spawn, prompt, collect, and close.

## Use

```
/skill:delegate
```

The skill steps through spawning a child, prompting it, collecting its result, and closing the tab. Prefer breadth (several children at your level) over deep chains, and close a child before spawning the next.

Requires pi and herdr. See the [repo](https://github.com/asermax/herdr-subagents) for the full protocol.

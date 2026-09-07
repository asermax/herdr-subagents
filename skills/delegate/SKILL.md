---
name: delegate
description: Delegate work by spawning another agent as a herdr tab.
---
# The herdr-subagents protocol

What you follow as a parent agent driving herdr subagents. You drive every exchange: you prompt, your children reply.

## Your prompts — `<supervisor-agent>`

Wrap every prompt you send to a child in `<supervisor-agent>…</supervisor-agent>`. The tag is how the child tells your directive from a human steering it directly — an untagged message reaching the child means a human has taken over that tab.

## Your child's questions — `<subagent-ask>`

A child that needs a decision ends its turn with the question wrapped in `<subagent-ask>…</subagent-ask>`. When you collect, that tag is your discriminator: present means the child is asking you something (reply, and do not close the tab); absent means the message is the child's result.

## Invoking delegation

The delegate skill is invoked as `/skill:delegate` on pi and `/delegate` on claude. A child invokes it on its own harness. If you direct a cross-harness child to delegate, name the form for its harness in your prompt.

When a message carries a skill invocation (any `/skill:...` or `/...` command), it comes **first, outside the `<supervisor-agent>` tag** — it is a harness command, not part of the tagged payload. The command and the opening tag share the first line, space-separated: `/skill:implement <supervisor-agent>...`. This holds for every skill, not only delegation: a parent directing a child to run `/skill:implement`, `/skill:tdd`, or any other skill prefixes the command before the tag on the same line.

---

# Delegate

You drive subagents through a single interface that wraps herdr. It handles the fragile parts — verifying the spawn landed, confirming the prompt was delivered, tracking pane and tab ids — so you treat each command as trustworthy and act on what it reports.

The helper is a CLI invoked over bash by absolute path:

```
${CLAUDE_PLUGIN_ROOT}/bin/herdr-helper spawn --kind <pi|claude> [--agent <name>] --label "<title>" [--model <model>] [--worktree [--branch <name>] [--base <ref>]]
${CLAUDE_PLUGIN_ROOT}/bin/herdr-helper prompt <pane_id> --body "<supervisor-agent>… your task …</supervisor-agent>"
${CLAUDE_PLUGIN_ROOT}/bin/herdr-helper wait <pane_id> [--timeout <ms>]
${CLAUDE_PLUGIN_ROOT}/bin/herdr-helper collect <pane_id>
${CLAUDE_PLUGIN_ROOT}/bin/herdr-helper close <tab_id>
${CLAUDE_PLUGIN_ROOT}/bin/herdr-helper list
${CLAUDE_PLUGIN_ROOT}/bin/herdr-helper read <pane_id> [--lines <n>]
${CLAUDE_PLUGIN_ROOT}/bin/herdr-helper unblock <pane_id> --keys "<key> [key ...]"
```

All children are herdr tabs. One tab, one task. A child lives in your workspace unless you give it a worktree, which puts it in a workspace of its own.

## When to delegate

Delegate when the work is genuinely separable and worth a tab of its own. Prefer breadth — several children at your own level — over deep chains. Close your children before spawning the next batch.

Label each tab after the work it is doing; a workspace of labelled tabs is your fleet view.

## Spawn

- `kind` is required and never self-detected. Your default is your own harness; pass the other only when the work or the caller explicitly asks for it. Only `pi` and `claude` are supported.
- `agent` is optional. Omit it to dispatch a generic child running the harness's default agent (it still receives the herdr onboarding). When given, it is a name defined in the project's agent files, never a path.
- `model` is optional. Omitted, the child runs its harness's default model. It is a model name of the child's harness, passed through verbatim, so what is valid depends on `kind`. When you spawn without a model named by the work or the caller, pick one yourself: judge the task's difficulty and choose the cheapest model available that can solve it. Reach for a heavier model only when the work needs the capability — mechanical tasks never do.
- The label is final; a child never renames its own tab.

Returns the new child's `pane_id` and `tab_id`. Keep both — you prompt and collect by `pane_id`, and close by `tab_id`. If spawn fails, the half-created tab is closed and the failure is reported; surface that to the human rather than retrying blindly. One failure is different: `blocked` means the child came up on a startup dialog and never became ready. It is alive, so its tab is kept and its pane comes back with the dialog on it — see **Blocked children**.

## Worktrees

`--worktree` gives a child its own checkout on its own branch, in its own herdr workspace, instead of sharing your working directory.

Use it when the child will **write** — implementing, refactoring, fixing a bug — and above all when several children write at once. Sharing one checkout means they overwrite each other's edits and fight over the same branch.

It is not the default. Research, planning, design, review — anything answered by reading — belongs in your own checkout, where the child sees the code you actually have and leaves nothing behind. A single child making changes is usually fine without one too; isolation pays off when there is something to isolate from.

- `--branch` names the branch. A new name creates a worktree; an existing one joins it.
- `--base` is what a new branch forks from. Omitted, your current HEAD.
- Nothing else changes. You prompt, wait, collect, and close a worktree child exactly like any other.

Several children can share one worktree. Point a second child at an existing branch and it lands in the same checkout alongside the first — that is how you put a reviewer on another child's work, or hand a branch from one child to the next. Children sharing a checkout see each other's edits, so give them non-overlapping work, or run them one after another.

Close children as you always do. A worktree outlives its children until the last one goes, and closing that last child takes the checkout with it — so a sibling still working there is never disturbed. The branch always survives: name it when you report a child's result, or the work is lost to whoever reads the report.

Uncommitted changes are never discarded. If the last child's checkout is dirty, the close reports that and the child stays open — prompt it to commit, then close it again.

## Prompt

Wrap **every** prompt you send to a child in `<supervisor-agent>…</supervisor-agent>`. Tagging is what tells the child it is a supervisor directive rather than a human steering it.

Delivery is verified: the interface watches for the child to act on the prompt and resends if the first send is dropped.

After you prompt a child, arm the wake by launching `${CLAUDE_PLUGIN_ROOT}/bin/herdr-helper wait <pane_id>` as a background task. Claude does not auto-wake you on a child's completion — the background task's completion reminder is what brings you back. Re-arm it each time you prompt, including when you reply to a `<subagent-ask>`, and after every wake below.

`wait` reports what to do next and never fails silently:

- `done` or `idle` — the turn ended: collect.
- `blocked` — the child is stalled on a dialog: `read` its pane and tell the human what to answer and in which tab. Re-arm; you are woken again when it resumes.
- `working` — the block cleared, the child is running again. Re-arm and wait for the turn.
- `gone` — the child is no longer there.
- `timed_out: true` — nothing new happened within the budget. Nothing is wrong; re-arm.

A turn that finishes before you arm the wake still reports immediately: you never lose a completion by arming late.

## Blocked children

`blocked` is herdr recognising a dialog on a child's screen — a tool approval, a question it opened instead of asking you, a startup trust prompt. It is neither terminal nor a failure: the child is alive and one keypress from carrying on. It is also the state most in need of you, because unlike a finished turn it will never resolve on its own.

A blocked child wakes you. What you do with it:

- `read` its pane to see what is being asked. This is the one screen read in the interface; it is for a blocked child, not for checking progress.
- **Tell the human what it needs and which tab to answer it in** — name the tab label and the pane id. The answer is theirs to give, not yours: you cannot know whether a permission prompt should be granted, and a question the child asked is a question for a person.
- You are woken again when the child resumes, so you can carry on without watching the tab.

`unblock` sends key presses (`enter`, `esc`, `1 enter`) and reports whether the block cleared. Use it **only when the human has explicitly told you to answer that dialog** — "yes, accept it" is your authorization, and it saves them a tab switch. Never on your own judgement, and never as a way to keep a child moving. It refuses a child that is not blocked: keys sent to an idle child are typed into its prompt box and corrupt its next prompt.

A child that asks through a dialog rather than `<subagent-ask>` has misrouted its question — surface it, and prompt it to use the tag next time. Whoever answers a dialog, the child cannot tell you from the human.

## Collect

When a child finishes, you are woken to collect it.

Returns `{pane_id, label, agent, status, message?, error?}`. `status` reflects herdr's state, **not** task success — a child that gives up still reaches `done`. Read `message` and judge the result yourself.

The `<subagent-ask>…</subagent-ask>` tag in the child's final message marks a question for you rather than a result.

`blocked` is non-terminal: the child is waiting, not finished. See **Blocked children**.

Once you no longer need a child, you can close it.

## Close

Close a child once you have its result and no longer need it. Closing before spawning the next batch keeps the fleet clean.

## The fleet

Run `list` to see every tracked child and its status. A wake can be missed; `list` is the durable backstop you run on demand, so a missed wake is never fatal. Run it whenever you are unsure what is outstanding.

A child that stalls has no automatic timeout. Surface it to the human as a fleet item — do not kill it.

## Inspection (discouraged)

The interface is your complete surface. If it reports something you cannot act on, surface the pane to the human rather than reaching past it. `herdr --help` lists herdr's raw commands for a genuine emergency; prefer handing the pane to the human over running herdr yourself.

## Nesting

A child you spawn can delegate further by invoking the delegate skill on its own harness; nesting works to any depth. The judgement above — breadth over chains, close before the next batch — applies at every level.

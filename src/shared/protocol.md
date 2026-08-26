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

{{invoke}}

All children are herdr tabs in your workspace. One tab, one task.

## When to delegate

Delegate when the work is genuinely separable and worth a tab of its own. Prefer breadth — several children at your own level — over deep chains. Close your children before spawning the next batch.

Label each tab after the work it is doing; a workspace of labelled tabs is your fleet view.

## Spawn

- `kind` is required and never self-detected. Your default is your own harness; pass the other only when the work or the caller explicitly asks for it. Only `pi` and `claude` are supported.
- `agent` is optional. Omit it to dispatch a generic child running the harness's default agent (it still receives the herdr onboarding). When given, it is a name defined in the project's agent files, never a path.
- The label is final; a child never renames its own tab.

Returns the new child's `pane_id` and `tab_id`. Keep both — you prompt and collect by `pane_id`, and close by `tab_id`. If spawn fails, the half-created tab is closed and the failure is reported; surface that to the human rather than retrying blindly. One failure is different: `blocked` means the child came up on a startup dialog and never became ready. It is alive, so its tab is kept and its pane comes back with the dialog on it — see **Blocked children**.

## Prompt

Wrap **every** prompt you send to a child in `<supervisor-agent>…</supervisor-agent>`. Tagging is what tells the child it is a supervisor directive rather than a human steering it.

Delivery is verified: the interface watches for the child to act on the prompt and resends if the first send is dropped.

{{wake}}

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

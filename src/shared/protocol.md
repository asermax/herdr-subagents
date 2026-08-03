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

You drive subagents through a helper CLI that wraps herdr. The helper handles the fragile parts — verifying the spawn landed, confirming the prompt was delivered, tracking pane and tab ids — so you treat each helper command as trustworthy and act on what it reports. It is invoked by absolute path, resolved per artifact root at build time; the shared source carries the path as a token and the build substitutes it.

All children are herdr tabs in your workspace. One tab, one task.

## When to delegate

Delegate when the work is genuinely separable and worth a tab of its own. Prefer breadth — several children at your own level — over deep chains. Close your children before spawning the next batch.

Label each tab after the work it is doing; a workspace of labelled tabs is your fleet view.

## Spawn

```
{{helper}} spawn --kind <pi|claude> --agent <name> --label "<title>"
```

- `--kind` is required and never self-detected. Your default is your own harness; pass the other only when the work or the caller explicitly asks for it. Only `pi` and `claude` are supported.
- `--agent <name>` is a name defined in `.claude/agents/*.md`, never a path.
- The label is final; a child never renames its own tab.

`{{helper}} spawn` returns the new child's `pane_id` and `tab_id`. Keep both — you prompt and collect by `pane_id`, and close by `tab_id`. If spawn fails, the helper closes the half-created tab and reports; surface that to the human rather than retrying blindly.

## Prompt

Wrap **every** prompt you send to a child in `<supervisor-agent>…</supervisor-agent>`. Tagging is what tells the child it is a supervisor directive rather than a human steering it.

```
{{helper}} prompt <pane_id> --body "<supervisor-agent>… your task …</supervisor-agent>"
```

{{wake}}

## Collect

When a child finishes, you are woken to collect it.

```
{{helper}} collect <pane_id>
```

Returns `{pane_id, label, agent, status, message?, error?}`. `status` reflects herdr's state, **not** task success — a child that gives up still reaches `done`. Read `message` and judge the result yourself.

Discriminate on the tag in the child's final message:

- Wrapped in `<subagent-ask>…</subagent-ask>` — the child is asking a question. Reply with `{{helper}} prompt` (wrapped in `<supervisor-agent>`), and do **not** close the tab.
- Otherwise — this is the child's result. You are done with it; close the tab.

`blocked` is non-terminal: a blocked child is still working or waiting, so leave it alone.

## Close

```
{{helper}} close <tab_id>
```

Close a child once you have its result and no longer need it. Closing before spawning the next batch keeps the fleet clean.

## The fleet

Run `{{helper}} list` to see every tracked child and its status. A wake can be missed; `list` is the durable backstop you run on demand, so a missed wake is never fatal. Run it whenever you are unsure what is outstanding.

A child that stalls has no automatic timeout. Surface it to the human as a fleet item — do not kill it.

## Inspection (discouraged)

The helper is your complete interface. If it reports something you cannot act on, surface the pane to the human rather than reaching past it. `herdr --help` lists herdr's raw commands for a genuine emergency; prefer handing the pane to the human over running herdr yourself.

## Nesting

A child you spawn can delegate further by invoking the delegate skill on its own harness; nesting works to any depth. The judgement above — breadth over chains, close before the next batch — applies at every level.

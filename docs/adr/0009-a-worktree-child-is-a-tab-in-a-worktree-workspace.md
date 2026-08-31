# A worktree child is a tab in a worktree workspace

A child spawned with `--worktree` gets its own checkout on its own branch, as a tab in the workspace herdr opens for that worktree. herdr does the git and the bookkeeping; the helper only decides where the child's tab goes and when the checkout is disposed.

## Context

Children shared the parent's checkout, which is fine while they read and wrong as soon as several of them write: concurrent edits land on one working tree and one branch. The obvious fix — drive `git worktree add` ourselves and pass the path as the child's `cwd` — turns out to be the wrong layer. herdr already has `worktree list | create | open | remove`, and it does not model a worktree as a directory: `worktree create` returns a **workspace** with its own first tab and root pane, and `WorkspaceInfo` carries the `worktree` block (`repo_root`, `checkout_path`, `is_linked_worktree`) that gives the workspace its presentation in the sidebar.

That presentation is workspace-level, not pane-level. Anything inside the workspace is inside the worktree, which is what makes reuse possible.

One obstacle: `WorktreeCreateParams` has no `env` field, and the gate (`HERDR_SUBAGENT=1`) reaches a child through `tab create --env`. So the root pane herdr hands back cannot be the child — an agent started there would come up ungated and never receive the onboarding.

## Decision

Spawn gains a step 0 that resolves a worktree and yields a workspace id and a checkout path. The existing `tabCreate` then runs against those instead of the parent's workspace and cwd; **the tab-creation path is unchanged**, so the gate, the label, the no-focus invariant, and everything downstream of the pane id are identical for both kinds of child. herdr's own root tab is closed afterwards — after ours exists, so the workspace never drops to zero tabs and disposes itself.

The branch name is the identity. An unknown branch gets a fresh worktree; a branch already checked out is joined, which is how a reviewer lands in an implementer's checkout. The branch defaults to the label, so a caller that only wants isolation names nothing.

Disposal has no verb of its own. The parent closes children, as it always has; when the child being closed is the last tab in its worktree, that close takes the checkout with it. The count comes from herdr's live tabs rather than from registry entries: a tab the human opened in the checkout keeps the count above one, so their work survives and the worktree lingers instead.

Nothing is ever forced. A dirty checkout refuses removal, the helper puts the child back in the registry, and the parent is told — the child is still alive, so it can be prompted to commit and closed again. The branch always survives removal; only the checkout goes.

## Considered options

- **Use the root pane herdr hands back, planting the gate with `pane run export HERDR_SUBAGENT=1` before `agent start`.** Verified to work — `agent start` launches the harness inside that pane's shell, so it inherits the exported environment. Rejected anyway: it is shell typing rather than process env, so it depends on the shell sitting at a prompt, has no delivery receipt, and leaves the export in the scrollback. `tab create --env` is real process environment and reuses the path already proven by every non-worktree child.

- **`pane split --cwd <checkout> --env ...` on the root pane.** Real process env, and one tab. Rejected: two panes per tab breaks one tab, one task, and `close` is tab-addressed.

- **Drive `git worktree add` and pass the path as `--cwd`.** Rejected: it duplicates work herdr already does, and a child in a plain directory gets none of the worktree presentation, because that lives on the workspace.

- **A `worktree remove` command on the helper.** Rejected: the parent's model is children, not checkouts. A verb for removing a worktree is a verb for destroying a sibling's workspace, and the last-one-out rule covers the real case without one.

- **Delete the branch along with the checkout.** Rejected: the checkout is scaffolding, the branch is the work.

## Consequences

- ADR-0001's "children are herdr tabs" still holds; "in the parent's workspace" no longer does. The fleet can span workspaces, and the skill says so.
- The watch is unaffected: per-child subscriptions are `pane_id`-filtered and the fleet subscription (`pane.created`, `tab.closed`) carries no workspace filter, so a child in its own workspace streams identically.
- `RegistryEntry` carries the worktree, so `close` can decide without asking the parent what kind of child it is holding.
- A spawn that fails removes a worktree it created and only closes the tab of one it joined — a joined checkout belongs to the siblings still in it.
- Resolve the worktree against the parent's `workspace_id`, not its `cwd`. Observed while building this: `worktree create --cwd <repo>` run from a pane that is not its workspace's main tab opened a *second* workspace bound to the source checkout, which `worktree remove` then left behind.
- A worktree whose last child cannot be removed — a dirty checkout, or a human tab still open in it — persists until someone deals with it. That is deliberate: there is no command to force it, and both cases are ones where forcing destroys work.

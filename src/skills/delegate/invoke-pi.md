Use the `subagent` tool for all delegation commands. Pass `command` and the relevant `options`:

| command  | options                                           |
| -------- | ------------------------------------------------- |
| spawn    | `{ kind, agent?, label, worktree?, branch?, base? }` |
| prompt   | `{ pane_id, body }`                               |
| wait     | `{ pane_id, timeout? }`                           |
| collect  | `{ pane_id }`                                     |
| close    | `{ tab_id }`                                      |
| list     | `{}`                                              |
| read     | `{ pane_id, lines? }`                             |
| unblock  | `{ pane_id, keys }`                               |

`wait` is rarely needed — your session auto-wakes you when a child finishes.

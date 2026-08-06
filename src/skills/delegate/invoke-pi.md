Use the `subagent` tool for all delegation commands. Pass `command` and the relevant `options`:

| command  | options                                           |
| -------- | ------------------------------------------------- |
| spawn    | `{ kind, agent?, label }`                         |
| prompt   | `{ pane_id, body }`                               |
| wait     | `{ pane_id, timeout? }`                           |
| collect  | `{ pane_id }`                                     |
| close    | `{ tab_id }`                                      |
| list     | `{}`                                              |

`wait` is rarely needed — your session auto-wakes you when a child finishes.

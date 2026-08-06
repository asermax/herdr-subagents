The helper is a CLI invoked over bash by absolute path:

```
{{helper}} spawn --kind <pi|claude> [--agent <name>] --label "<title>"
{{helper}} prompt <pane_id> --body "<supervisor-agent>… your task …</supervisor-agent>"
{{helper}} wait <pane_id> [--timeout <ms>]
{{helper}} collect <pane_id>
{{helper}} close <tab_id>
{{helper}} list
```

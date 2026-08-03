<!-- claude delegate skill fragment -->
<!-- Injects into {{wake}} in protocol.md -->

After you prompt a child, arm the wake by launching `{{helper}} wait <pane_id>` as a background task. Claude does not auto-wake you on a child's completion — the background task's completion reminder is what brings you back to collect. Re-arm it each time you prompt, including when you reply to a `<subagent-ask>`.

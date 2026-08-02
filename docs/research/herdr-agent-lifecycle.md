# herdr agent lifecycle surface — research for the herdr-subagents package

Research question: what does herdr give us for spawning, driving, detecting
completion of, and cleaning up an agent in another tab — and where are the gaps?

All findings are from the installed `herdr 0.7.5` at `/usr/bin/herdr`, its
socket API at `~/.config/herdr/herdr.sock` (protocol 17, schema via
`herdr api schema --json`), and the live session. Every command and response
quoted was run against the live server. Where the socket exposes something the
CLI does not, the call was made directly with a one-line JSON-RPC client.

The headline, because it changes the design: **agent state is push-based, not
polled.** `events.subscribe` streams `pane.agent_status_changed` in real time
(verified), and `done` is a real status a caller can match on. The
`herdr-command-watch` README's "herdr has no output event a plugin can reach" is
true only for *output content*; it does not hold for agent state. See §9.

## Conventions in the data

- IDs are scoped: `w1Y` workspace, `w1Y:t6` tab, `w1Y:p6` pane. All three are
  stable strings.
- Every CLI command prints a JSON-RPC envelope: `{"id":..., "result":...}` on
  success or `{"error":{"code":..., "message":...}}` on failure. Non-zero exit
  accompanies errors.
- The agent state enum is fixed at `idle | working | blocked | done | unknown`
  (`AgentStatus` in the schema).

## 1. `herdr tab create`

Flags (from `herdr tab create --help`): `--workspace <id>`, `--cwd <path>`,
`--label <text>`, `--env <KEY=VALUE>` (repeatable), `--focus` / `--no-focus`.

```
$ herdr tab create --workspace w1Z --cwd /tmp --label hc-tab --no-focus --env HCTEST=1
{"id":"cli:tab:create","result":{"root_pane":{"agent_status":"unknown",
"cwd":"/tmp","focused":false,"pane_id":"w1Z:p2","revision":0,
"scroll":{"max_offset_from_bottom":0,"offset_from_bottom":0,"viewport_rows":52},
"tab_id":"w1Z:t2","terminal_id":"term_...","workspace_id":"w1Z"},
"tab":{"tab_id":"w1Z:t2","workspace_id":"w1Z","number":2,"label":"hc-tab",
"focused":false,"pane_count":1,"agent_status":"unknown"},"type":"tab_created"}}
```

Returned JSON: `{root_pane, tab, type:"tab_created"}`. The `root_pane` object is
the important part — it carries the new `pane_id`, `tab_id`, `cwd`, and
`scroll`. `--label` sets the tab label; it is **not** a usable agent target
(see §6).

The new tab starts at an interactive shell prompt. Reading the pane right after
create shows the user's shell prompt (starship, in this session), not a blank
screen:

```
$ herdr pane read w1Z:p2 --source visible
  /tmp ▓▒░ ░▒▓ ✔ INSERT
```

`--env` sets an environment variable for the launched shell process (the PTY is
spawned with it); it is not injected into an already-running shell. `--no-focus`
leaves the caller's focus untouched, which matters for a supervisor that must
not steal the user's pane while spawning tabs.

`herdr workspace create` returns the same triple plus a `root_pane` — it is the
cleanest way to isolate a subagent: create a workspace, get its `root_pane_id`,
and close the whole workspace for teardown (§8).

## 2. `herdr agent start`

```
herdr agent start <NAME> --kind <KIND> --pane <ID> [--timeout <MS>] [-- ARGS...]
```

`--kind` is restricted to a fixed list (`pi, claude, codex, gemini, cursor,
devin, agy, cline, omp, mastracode, opencode, copilot, kimi, kiro, droid, amp,
grok, hermes, kilo, qodercli, maki`). Args after `--` are passed through to the
harness as `argv` (socket field `args`). With no args, `argv` is just the
canonical executable:

```
$ time herdr agent start hcpi --kind pi --pane w1Z:p3
{"id":"cli:agent:start","result":{"agent":{"agent":"pi",
"agent_session":{"agent":"pi","kind":"path","source":"herdr:pi",
"value":"/home/agus/.pi/agent/sessions/--tmp-hctest-pi--/....jsonl"},
"agent_status":"idle","cwd":"/tmp/hctest-pi","interactive_ready":true,
"name":"hcpi","pane_id":"w1Z:p3","screen_detection_skipped":true,
"state_change_seq":101,"tab_id":"w1Z:t3","workspace_id":"w1Z"},
"argv":["pi"],"type":"agent_started"}}
real 0m3.054s
```

Readiness detection blocks until the agent is interactive-ready, then returns.
The ~3s wall time above is herdr waiting for pi's TUI to be ready, not a fixed
delay. `interactive_ready: true` in the result is the readiness signal.
`--timeout` bounds this wait (default 30000ms, max 300000ms; values must be
>3000). A detected pi carries `screen_detection_skipped: true` — herdr trusts
the agent's own readiness signal rather than screen-scraping.

The pane must be at an interactive shell prompt. Three failure modes, observed:

| Condition | `error.code` | message |
| --- | --- | --- |
| pane does not exist | `agent_pane_not_found` | `agent target pane w1Z:pNOPE not found` |
| pane not at a shell prompt (a command is in the foreground) | `agent_pane_busy` | `agent target pane w1Z:p1 is not an available shell` |
| unknown `--kind` | (stderr, non-JSON) | `unsupported interactive agent kind: bogus` |

The `agent_pane_busy` check is the same signal `herdr-command-watch` uses:
`pane.process_info` returns `shell_pid` and `foreground_process_group_id`; when
they differ, a command owns the tty and the pane is not "an available shell".

A started agent's initial status is **`idle`**, not `done` (see §4).

## 3. `agent prompt` / `send-keys` / `send-text`

Three input primitives with different semantics:

- `herdr pane send-text <PANE> <TEXT>` — literal text, no submit.
- `herdr pane send-keys <PANE> <KEY>...` — key *names* (`Enter`, `esc`, etc.),
  not literal text. `send-keys w1Z:p1 sleep 300 Enter` fails with
  `unsupported key sleep`; type the text with `send-text`, then `send-keys Enter`.
- `herdr agent prompt <TARGET> <TEXT>` — submits a prompt to a detected agent.
  `--wait` waits for the first matching status after submission; `--until
  <status>` (repeatable) overrides the default match set `idle|done|blocked`;
  `--timeout <MS>` bounds it.

**Multi-line prompts: `agent prompt` handles them correctly. The first newline
does not submit early.** Sent a two-line prompt where the line count changes the
answer:

```
$ PROMPT="$(printf 'Reply with only the number of lines you received in this message, as a single digit, then stop.\nSecond line here. Do not use any tools.')"
$ herdr agent prompt w1Z:p3 "$PROMPT" --wait --timeout 60000
```

The pane afterwards showed both lines arriving as one message and pi answering
`2`:

```
 Reply with only the number of lines you received in this message, as a single digit, then stop.
 Second line here. Do not use any tools.

 Thinking...

 2
```

So `agent prompt` wraps the text (bracketed paste) before submitting; embedded
newlines are preserved as part of one prompt.

The low-level primitives do **not** do this. `pane send-text` with an embedded
newline submits on the first newline:

```
$ herdr pane send-text w1Z:p2 "$(printf 'echo AAA\necho BBB')"
# scrollback afterwards:
❯ echo AAA
AAA
 <prompt buffer> echo BBB        # line 2 is sitting in the buffer, not executed
```

`echo AAA` ran immediately; `echo BBB` was left in the input buffer. A driver
that builds prompts from `send-text` + `send-keys Enter` must wrap multi-line
input itself, or just use `agent prompt`.

Caveat on `prompt --wait`, from `--help`: when submission starts from a
non-working state, `--wait` first requires an observed state change within
5000ms or it returns `agent_prompt_stalled` (a shorter `--timeout` returns
`timeout` instead). It then matches the target set. It does **not** track turns:
if the agent is already working, that active turn's completion can match the
wait. Without `--timeout`, the settled-state wait is indefinite.

## 4. `agent wait` and `prompt --wait --until`

State machine: `idle | working | blocked | done | unknown`.

- `idle` — at the ready, acknowledged. A freshly started agent is `idle`.
- `working` — mid-turn.
- `blocked` — stalled (no output for the stall window); surfaced by
  `herdr-command-watch` for plain commands and by agents that signal it.
- `done` — finished a turn, unacknowledged. Derived by herdr from a
  non-idle → `idle` transition (see §7 and §9); it is not something you report
  directly.
- `unknown` — no agent detected, or detection lost.

**A caller can tell "finished a turn" apart from "idle at startup": they are
different statuses.** After the two-line prompt above, `agent get` reported
`agent_status: "done"`; a brand-new `agent start` reported `idle`. `done`
persists until acknowledged (focusing the pane, or the next prompt).

`agent wait` returns as soon as the status is in the target set, including the
current status — waiting `--until done` on an agent that is already `done`
returns instantly:

```
$ time herdr agent wait w1Z:p3 --until done --timeout 4000
{"id":"cli:agent:wait","result":{"agent":{...,"agent_status":"done",...}}}
real 0m0.003s
```

Default `agent wait` (no `--until`) matches `idle | done | blocked`. Pass
`--until unknown` explicitly when that is what you want. Without `--timeout`,
`agent wait` blocks indefinitely. Note `wait`/`prompt --wait` match on *status*,
not on a specific turn boundary — there is no turn id, only `state_change_seq`
(a monotonic per-agent counter visible in `agent get` and the snapshot) and
`revision` (a per-pane metadata counter).

## 5. `agent read` / `pane read`

`herdr agent read <TARGET> [--source S] [--lines N] [--format text|ansi]`
(`pane read` is the same minus agent targeting). Sources: `visible` (viewport),
`recent` (wrapped scrollback, default), `recent-unwrapped`, `detection` (the
raw screen buffer herdr's detector sees).

What is returned is **painted terminal content**, not structured messages. With
ANSI stripped it is the literal screen: box-drawing borders, the status bar, the
prompt, and the agent's rendered text. From a socket call:

```json
{"method":"pane.read","params":{"pane_id":"w1Y:p6","source":"visible","lines":3,"strip_ansi":true}}
{"result":{"read":{"pane_id":"w1Y:p6","source":"visible","format":"text",
"revision":0,"truncated":false,
"text":"─────... INSERT\n~/workspace/.../herdr-subagents  [main +4 ~0 -0 !]\n↑63k ↓7.7k R476k 6.3%/1.0M  (zai) glm-5.2 • high\n"}}}
```

Scrollback is large and reachable. `source=recent` on a busy pane returned 623
lines / ~22KB with `truncated: false`; `--lines` caps the slice, not the buffer.

Two facts that make screen-scraping fragile:

1. `revision` on a read result is **always 0** — confirmed. It does not track
   output changes, so a driver cannot cheaply "read only if changed" from `read`
   alone. (The `pane_output_changed` event carries a real revision; see §9.)
2. There are no message-boundary markers that are not also TUI chrome. The
   `detection` source even shows the agent collapsing old turns inline
   (`... (21 earlier lines, ctrl+o to expand)`), because that is what the agent
   painted. Extracting "just the last assistant message" means parsing a TUI
   that was not designed to be parsed.

The reliable alternative to screen-scraping is not `read` — it is the agent's
own session log. Detected agents carry `agent_session` in the snapshot: pi is
`{kind:"path", value:".../sessions/<id>.jsonl"}`, claude is
`{kind:"id", value:"<session-uuid>"}`. A supervisor that knows the harness can
read the structured transcript from that path/id instead of the screen (§Gaps).

## 6. `agent list` / `get` — what is a valid `<TARGET>`

`<TARGET>` resolves **agent name** and **pane id** only. Tested against agent
`research-2` at `w1Y:p6` (tab `w1Y:t6`, tab label `#2 herdr agent lifecycle`):

| Target form | resolves? |
| --- | --- |
| agent name `research-2` | yes |
| pane id `w1Y:p6` | yes |
| tab id `w1Y:t6` | no — `agent_not_found` |
| tab label `#2 herdr agent lifecycle` | no — `agent_not_found` |
| tab number `6` | no — `agent_not_found` |

So a supervisor must keep the pane id (or the agent name it set at `start`).
Tab id/label/number are not agent targets. `agent get` returns the full agent
object (status, `agent_session`, `state_change_seq`, `cwd`, `tokens`); `pane
current` / `pane current --current` returns the same fields plus `scroll`.

## 7. `pane report-agent` / `report-metadata` / `release-agent`

These let any process claim a pane's agent slot. `herdr-command-watch` is the
reference implementation (`src/surface-effect.ts`, `src/watcher.ts`).

- `pane.report_agent {pane_id, source, agent, state, message?}` — claims the
  slot under name `agent` and reports `state` ∈ `idle | working | blocked |
  unknown`. There is no `done` input: herdr **derives `done`** from a
  non-idle → `idle` transition. Verified by reporting `working`, then `blocked`,
  then `idle` and watching the event stream emit `working`, `blocked`, `done`
  (§9). The report drives herdr's attention queue and the desktop notification;
  the plugin never notifies itself.
- `pane.report_metadata {pane_id, source, tokens?, display_agent?, title?,
  state_labels?, ttl_ms?}` — display-only badges. `tokens` is a string map
  (e.g. `{dur:"2m56s", watching:"1"}`); it **merges, never replaces**, and
  survives pane-id reuse, so cleanup must null each key by name
  (`tokens:{dur:null, watching:null}`). `herdr-command-watch` avoids
  `display_agent` because each `report_agent` blanks it for up to a second and
  the row flickers; it puts the command name straight into the `agent` field
  instead.
- `pane.release_agent {pane_id, source, agent}` — releases the claim. The
  `agent` name must match the name the claim was made under.
- `pane.report_agent_session {pane_id, source, agent, agent_session_id?,
  agent_session_path?}` — reports the agent's session identity (the same
  `agent_session` a detected agent exposes).

Ownership/reclaim: `herdr-command-watch` stamps a `watching:"1"` token on every
pane it claims, so a restarted watcher can find and release orphaned claims
(`releaseOrphans` in `watcher.ts`). The acknowledgement model is focus: while
tracked, the pane reports the command as its agent; focusing the pane hands the
slot back and clears the row.

## 8. `tab close` / `workspace close` — cleanup and targeting

Both are **id-only**.

```
$ herdr tab close hc-tab            # by label
{"error":{"code":"tab_not_found","message":"tab hc-tab not found"}}
$ herdr tab close w1Z:t2            # by id
{"id":"cli:tab:tab:close","result":{"type":"ok"}}
$ herdr workspace close w1Z         # by id
{"id":"cli:workspace:close","result":{"type":"ok"}}
```

`workspace close` tears down the whole workspace — every tab and pane in it,
killing any agent running there. After `workspace close w1Z`, the workspace, the
`sleep 300` test pane, and the `hcpi` pi agent were all gone from the snapshot.
This is the clean teardown path for an isolated subagent: spawn into a dedicated
workspace, close the workspace to reap everything.

Targeting the parent's workspace reliably: a subagent finds its own pane with
`herdr pane current` (returns `pane_id`, `workspace_id`, `tab_id`), and the
parent's pane/workspace from `session.snapshot` (the snapshot lists every pane
with its `agent`, `agent_session`, `cwd`, and focus flag). There is no
"my parent" pointer — a supervisor identifies the parent by matching on
`agent_session` or `cwd`, or by a convention it set itself at spawn time.

## 9. Socket API — events vs polling

The CLI has no `events` subcommand. The socket exposes two methods the CLI does
not surface: `events.subscribe` (stream) and `events.wait` (one-shot). Both are
in `herdr api schema --json`.

The `Subscription` enum (what `events.subscribe` will stream) includes:

```
workspace.*, tab.created/closed/focused/renamed/moved,
pane.created/closed/updated/focused/moved/exited/agent_detected,
pane.output_matched, pane.agent_status_changed, pane.scroll_changed, layout.updated
```

`pane.agent_status_changed` is a **real-time stream**, and it carries the full
status. Subscribed to one pane, then drove its state with `report_agent`:

```
subscribe: {"subscriptions":[{"type":"pane.agent_status_changed","pane_id":"w1Z:p2"}]}
# report working -> report blocked -> report idle
[stream] {"result":{"type":"subscription_started"}}
[stream] {"event":"pane.agent_status_changed","data":{"agent_status":"working","agent":"fakecmd",...}}
[stream] {"event":"pane.agent_status_changed","data":{"agent_status":"blocked", ...}}
[stream] {"event":"pane.agent_status_changed","data":{"agent_status":"done",   ...}}   # idle was derived into done
```

`events.wait` (one-shot, underscore event names in `EventMatch`) works too:

```
wait: {"match_event":{"event":"pane_agent_status_changed","pane_id":"w1Z:p2","agent_status":"done"},"timeout_ms":8000}
[wait]  {"result":{"type":"wait_matched","event":{"event":"pane_agent_status_changed",
         "data":{"agent_status":"done",...}}}}
```

This is the correction to `herdr-command-watch`'s "Why polling" README. That
section is correct **for output content**: there is no continuous
`pane.output_changed` stream (it is in the one-shot `events.wait` `EventMatch`
enum and in the broadcast `EventKind` enum, but not in the stream
`Subscription` enum), and `pane.read`'s `revision` is always 0. Detecting
output activity still needs polling (or `pane.scroll_changed` as a cheap proxy,
which *is* streamable). But the README's framing — "herdr has no output event a
plugin can reach" — does not extend to agent state. For agent lifecycle, a
supervisor subscribes to `pane.agent_status_changed` and gets working / blocked
/ done / idle transitions pushed, with no polling and instant completion
detection.

Why `herdr-command-watch` polls anyway (`src/watcher.ts`): its job is detecting
*output stalls* on plain commands, which has no event, so it runs a 1s
`session.snapshot` + `pane.process_info` + `pane.read` loop and reports state
from the same tick. A pure agent-state supervisor has no such constraint.

## Gaps — what we build ourselves

1. **Result extraction.** `agent read` returns painted screen content; there is
   no "last assistant message" or structured result. The robust path is to read
   the agent's own session via `agent_session` (pi: the `.jsonl` path; claude:
   the session id), not the screen. We own that parsing.
2. **No turn id / no "this prompt's result".** State matching is by status and
   monotonic `state_change_seq`, not by turn. To attribute a `done` to a
   specific prompt, a supervisor records `state_change_seq` before submitting
   and reads the new transcript content after. The `prompt --wait` "already
   working" caveat means a prompt issued while busy can match the in-flight
   turn — a supervisor must serialize prompts per agent or track the seq
   itself.
3. **Event API is socket-only.** `events.subscribe` / `events.wait` are not on
     the CLI. A supervisor that wants push-based completion must speak
     JSON-RPC to `~/.config/herdr/herdr.sock` (newline-delimited, one-line
     request → one-line response; subscriptions keep the socket open and stream
     `SubscriptionEventEnvelope`s). This is a small client (~30 lines; see
     `herdr-command-watch/src/herdr-client.ts`).
4. **No "my parent" link.** herdr knows pane → agent_session, not agent →
   parent-agent. Linking a subagent tab back to the supervisor that spawned it
   is our convention (a name, a token, or matching on `agent_session`/`cwd`).
5. **Teardown is ours to drive.** `workspace close` reaps a subagent cleanly,
   but nothing auto-closes a finished subagent tab. The supervisor must close
   it (and decide when "done" is also "reaped" — `done` persists until
   acknowledged).
6. **Multi-line safety is `agent prompt`-only.** Building prompts from
   `send-text` + Enter breaks on the first newline. We standardize on
   `agent prompt` (or wrap paste ourselves).
7. **Output-streaming (if ever needed) is still polling.** `pane.read`
   `revision` is always 0 and there is no output-content stream; only
   `pane.scroll_changed` and one-shot `pane.output_matched` /
   `pane_output_changed` waits are available without polling.

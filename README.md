# herdr-subagents

A Claude Code plugin and a pi package, built from one source, that let a coding
agent delegate work by spawning other agents as herdr tabs.

The repo is **pure source**. The build turns it into two derived, gitignored
artifacts. See `CONTEXT.md` for the glossary and `docs/adr/` for decisions.

## Build

The shared node toolchain lives at the repo root.

```sh
npm install        # one-time
npm run build      # emit build/out/{pi,claude}
npm test           # unit tests
npm run typecheck  # strict tsc --noEmit
```

The build reads pure-source Markdown under `src/`, substitutes the token from
a per-harness map, bundles the helper (and, for claude, the mod), and emits
two complete artifacts into `build/out/`
(gitignored):

- `build/out/pi/` — the pi npm package (`@asermax/pi-herdr-subagents`)
- `build/out/claude/` — the Claude plugin (`herdr-subagents`)

## The token contract

Source is readable Markdown with substitution tokens. The token set is exactly
one:

| Token        | Value                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| `{{invoke}}` | The per-harness table of the `subagent` tool's commands (`src/skills/delegate/invoke-{pi,claude}.md`). |

The build:

- substitutes `{{invoke}}` from a per-harness map into each artifact;
- **errors on any unknown token** (no silent passthrough of a misspelled `{{...}}`);
- **asserts token coverage in both directions** — every map entry is consumed in
  source, and every `{{...}}` in source has a map entry;
- copies token-free files verbatim.

Drift between the two artifacts is prevented by construction: one source,
generated-only outputs, and the both-directions coverage assertion. There is
deliberately **no build-output diff test** (spec Testing §"Not tested").

## Shared core

`src/core/` holds the harness-agnostic halves of the `subagent` tool
(`subagent.ts`) and of the parent role (`fleet.ts`). Both files are Node-free
and import nothing. The pi extension imports them; the Claude mod
(`src/claude/mod/`) bundles them into `hooks/register.js`, because a Claude
hooks module has no Node and may only import its own plugin's files. See
ADR-0010.

## Versioning

One `VERSION` file at the repo root is the single source. The build injects it
into both shipped manifests (`build/out/pi/package.json` and
`build/out/claude/.claude-plugin/plugin.json`, plus the marketplace entry), so
bumping one file moves both artifacts together. The root `package.json` (the
devel workspace, `private: true`) carries the same version out of band.

## Distribution

The two artifacts ship through symmetric channels:

- **pi package** — `@asermax/pi-herdr-subagents` on npm. `npm run build && cd
  build/out/pi && npm publish`.
- **Claude plugin** — the orphan `claude-marketplace` branch, regenerated and
  force-pushed by CI on every push to `main`. Install with
  `claude plugin install herdr-subagents@herdr-subagents` after adding the
  marketplace (`claude plugin marketplace add asermax/herdr-subagents`).

## The dev loop

The dev loop needs no publishing. Both artifacts load from source trees, so
editing takes a session restart (pi) or a flag (claude).

```sh
npm run build          # emit build/out/{pi,claude}
npm run build:skills   # just the artifacts
```

For a `--watch` rebuild, run `npm run build:skills` on save (no watcher is
bundled). A rebuild + session restart is the whole loop for generated skills.

### pi extension

Load the extension directly from source, pointing its `helperPath()` at the
built helper:

```sh
pi --extension ./src/extension/index.ts --skill ./build/out/pi/skills
```

`HERDR_SUBAGENT_HELPER` overrides the helper binary path, so a session loading
the extension from source (where `./herdr-helper` does not yet exist) finds the
built one:

```sh
HERDR_SUBAGENT_HELPER=$PWD/build/out/pi/herdr-helper \
  pi --extension ./src/extension/index.ts --skill ./build/out/pi/skills
```

Editing the extension needs only a session restart. Editing the generated
skill needs a rebuild (`npm run build:skills`) then a fresh session or
`--skill <path>`.

### Claude plugin

Load the built output with the plugin-directory flag, and set
`HERDR_SUBAGENT_PLUGIN_DIR` so the parent's claude children load it too. If the
published plugin is installed, turn it off for the session:

```sh
HERDR_SUBAGENT_PLUGIN_DIR=$PWD/build/out/claude \
  claude --plugin-dir ./build/out/claude \
  --settings '{"enabledPlugins":{"herdr-subagents@herdr-subagents":false}}'
```

Rebuild and restart after editing source. `claude plugin validate
build/out/claude` checks the bundled mod the way Claude Code loads it.

### Children inherit the dev loop

A parent under development passes the same flags to its children through the
launch argv. The helper's `spawn` forwards two things to every child it spawns:

- **argv** — every flag on the parent's `helper spawn ...` command that `spawn`
  does not consume itself (`--extension`, `--skill`, `--plugin-dir`, …)
  rides onto the child's `agent start` argv. Not an allowlist: the complement
  of spawn's own surface, so future flags forward by default. The Claude mod
  adds `--plugin-dir $HERDR_SUBAGENT_PLUGIN_DIR` to claude spawns when the
  variable is set.
- **env** — the gate (`HERDR_SUBAGENT=1`) plus every `HERDR_SUBAGENT_*` var the
  parent carries (always forwarded, no dev/prod switch). herdr's own `HERDR_*`
  vars are a different owner and are not forwarded.

In production nothing is passed: the parent runs with no dev flags and no
`HERDR_SUBAGENT_*` env, so children launch with only `--agent <name>` and the
gate. A dev parent that launched with `--extension ./src/extension/index.ts`
and `HERDR_SUBAGENT_HELPER=...` propagates both to every child automatically.
On claude, `HERDR_SUBAGENT_PLUGIN_DIR` plays the same role: it is forwarded as
a `HERDR_SUBAGENT_*` variable and turned into `--plugin-dir` at every level.

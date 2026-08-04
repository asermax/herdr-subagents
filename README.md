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
npm test           # unit tests for the substitution engine
npm run typecheck  # strict tsc --noEmit
```

The build reads pure-source Markdown under `src/`, substitutes the two tokens
from a per-harness map, and emits two complete artifacts into `build/out/`
(gitignored):

- `build/out/pi/` — the pi npm package (`@asermax/pi-herdr-subagents`)
- `build/out/claude/` — the Claude plugin (`herdr-subagents`)

## The token contract

Source is readable Markdown with substitution tokens. The token set is exactly
two (spec §9):

| Token        | Value                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| `{{wake}}`   | The per-harness wake fragment (`src/skills/delegate/{pi,claude}.md`).                  |
| `{{helper}}` | The helper's absolute path, resolved per artifact root at build time (shipped by #17). |

The build:

- substitutes `{{wake}}` and `{{helper}}` from a per-harness map into each artifact;
- **errors on any unknown token** (no silent passthrough of a misspelled `{{...}}`);
- **asserts token coverage in both directions** — every map entry is consumed in
  source, and every `{{...}}` in source has a map entry;
- copies token-free files verbatim.

Drift between the two artifacts is prevented by construction: one source,
generated-only outputs, and the both-directions coverage assertion. There is
deliberately **no build-output diff test** (spec Testing §"Not tested").

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

Load the built output with the plugin-directory flag:

```sh
claude --plugin-directory ./build/out/claude
```

Rebuild and restart after editing source.

### Children inherit the dev loop

A parent under development passes the same flags to its children through the
launch argv. The helper's `spawn` forwards two things to every child it spawns:

- **argv** — every flag on the parent's `helper spawn ...` command that `spawn`
  does not consume itself (`--extension`, `--skill`, `--plugin-directory`, …)
  rides onto the child's `agent start` argv. Not an allowlist: the complement
  of spawn's own surface, so future flags forward by default.
- **env** — the gate (`HERDR_SUBAGENT=1`) plus every `HERDR_SUBAGENT_*` var the
  parent carries (always forwarded, no dev/prod switch). herdr's own `HERDR_*`
  vars are a different owner and are not forwarded.

In production nothing is passed: the parent runs with no dev flags and no
`HERDR_SUBAGENT_*` env, so children launch with only `--agent <name>` and the
gate. A dev parent that launched with `--extension ./src/extension/index.ts`
and `HERDR_SUBAGENT_HELPER=...` propagates both to every child automatically.

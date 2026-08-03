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

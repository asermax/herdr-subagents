#!/usr/bin/env bash
# SessionStart onboarding hook (spec §6). Gated on HERDR_SUBAGENT: when the gate
# is set, write the static onboarding to stdout — Claude injects stdout as
# context. When it is absent, exit silently so a normal session pays nothing.
# The matcher (startup|resume|clear|compact) survives context compression.

set -u

if [ -z "${HERDR_SUBAGENT:-}" ]; then
  exit 0
fi

# The plugin root is the parent of the hooks/ directory this script lives in.
plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cat "${plugin_root}/skills/onboarding.md"

exit 0

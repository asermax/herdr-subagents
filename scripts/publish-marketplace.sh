#!/usr/bin/env bash
# Regenerate the claude-marketplace orphan branch from the built plugin tree.
#
# Runs in the release pipeline after the build, so build/out/claude holds the
# plugin stamped with the released version. The push happens in a throwaway
# clone so it never touches semantic-release's working tree (the git plugin
# still has to commit VERSION + CHANGELOG there).
set -euo pipefail

version="${1:?usage: publish-marketplace.sh <version>}"

remote="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet "$remote" "$work"
git -C "$work" checkout --orphan claude-marketplace
# Clear the cloned main tree so only the plugin tree ends up on the orphan.
git -C "$work" rm -rf --quiet .

cp -r "${GITHUB_WORKSPACE}/build/out/claude/." "$work"

git -C "$work" config user.name "github-actions[bot]"
git -C "$work" config user.email "github-actions[bot]@users.noreply.github.com"
git -C "$work" add -A
git -C "$work" commit --quiet -m "chore(marketplace): regenerate @ ${version}"

git -C "$work" push --force --quiet "$remote" HEAD:claude-marketplace

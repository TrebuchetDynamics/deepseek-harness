#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

branch="$(git branch --show-current)"
[ "$branch" = master ] || { echo "error: expected master, found ${branch:-detached HEAD}" >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "error: tracked changes must be committed or stashed" >&2; exit 1; }

git fetch upstream master
git merge --no-edit upstream/master

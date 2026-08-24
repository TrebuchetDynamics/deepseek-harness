#!/usr/bin/env bash
# Merge upstream/master into this fork's master, re-pin the Docker image,
# validate, and summarize the fork's remaining differences. Rerunnable: after
# a conflicted merge is resolved and committed by hand, rerunning this script
# skips the merge and completes the remaining steps.
#
#   ./upstream-merge.sh
#
# On conflict the script exits 1 with the conflicted file list, leaving the
# in-progress merge for manual resolution ('git merge --abort' cancels). It
# never pushes: review the result, then 'git push'.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "error: $*" >&2; exit 1; }

branch="$(git branch --show-current)"
[ "$branch" = master ] || die "expected master, found ${branch:-detached HEAD}"
git diff --quiet && git diff --cached --quiet || die "tracked changes must be committed or stashed"
git remote get-url upstream >/dev/null 2>&1 \
  || die "no 'upstream' remote; add it with: git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git"

git fetch upstream master
pre_merge_head="$(git rev-parse HEAD)"

if git merge-base --is-ancestor upstream/master HEAD; then
  echo "upstream/master already merged; checking post-merge steps"
else
  echo "merging $(git rev-list --count master..upstream/master) upstream commits ($(git rev-parse --short HEAD)..$(git rev-parse --short upstream/master))"
  if ! git merge --no-edit upstream/master; then
    echo >&2
    echo "conflicted files (resolve, then 'git commit'):" >&2
    git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
    echo "bilingual pairs: 'pnpm run resolve-translation-pairing-conflicts'; cancel with 'git merge --abort'" >&2
    exit 1
  fi
fi

# The Docker image pins the release it serves; keep it on the merged version.
image_version="$(sed -n 's/^ARG DSH_VERSION=//p' Dockerfile)"
repo_version="$(node -p "require('./package.json').version")"
if [ "$image_version" != "$repo_version" ]; then
  sed -i "s/^ARG DSH_VERSION=.*/ARG DSH_VERSION=$repo_version/" Dockerfile
  git commit -am "chore(docker): re-pin DSH_VERSION to $repo_version after upstream merge" --quiet
  echo "re-pinned Dockerfile DSH_VERSION: $image_version -> $repo_version"
fi

# New or changed dependencies must be installed before anything typechecks.
if git diff --name-only "$pre_merge_head" HEAD -- pnpm-lock.yaml | grep -q .; then
  pnpm install
fi

pnpm run typecheck || die "typecheck failed; fix before pushing"

echo
echo "fork summary against upstream/master:"
echo "  fork-only commits (excluding merges): $(git rev-list --count --no-merges upstream/master..HEAD)"
git log --format='    %h %s' --no-merges upstream/master..HEAD
git diff --stat --stat-count=40 upstream/master...HEAD

echo "synced with upstream/master and validated; push with: git push"

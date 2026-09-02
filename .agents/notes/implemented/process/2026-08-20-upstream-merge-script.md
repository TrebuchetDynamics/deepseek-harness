# Agent Note: upstream-merge.sh owns the fork's upstream sync end to end

Status: implemented

English | [中文](2026-08-20-upstream-merge-script.zh.md)

## Problem

`upstream-merge.sh` was four lines: verify the branch, verify a clean tree, `git fetch upstream master`, `git merge --no-edit upstream/master`. Every step after the merge lived only in the operator's head: the `Dockerfile` comment "bump DSH_VERSION together with the upstream sync" (the image pins the release it installs; a merge that forgets the bump builds an image one release behind the checkout it serves), `pnpm install` after lockfile changes (without it, the next typecheck or `dsh` launch runs against stale dependencies), and any pre-push validation. A conflicted merge dumped git's raw output with no pointer to the repo's bilingual-pair resolution tooling. The script also could not be resumed: after a manual conflict resolution, rerunning it refetched and started a fresh merge assessment with none of the unfinished follow-up steps.

## Decision

The script stays a linear pre-merge → merge → post-merge pipeline, made rerunnable and self-completing:

- **Pre-merge** keeps the existing guards (on `master`, clean tracked tree) and adds a check that the `upstream` remote exists, with the exact `git remote add` command in the error.
- **Merge** counts the incoming commits, runs `git merge --no-edit upstream/master`, and on conflict exits 1 leaving the in-progress merge in place, printing the conflicted files (`git diff --name-only --diff-filter=U`) and the two escape hatches: `pnpm run resolve-translation-pairing-conflicts` for the bilingual pairs whose i18n consistency records conflict through the repo's merge driver, and `git merge --abort` to cancel.
- **Rerunnability** is the structural change: `git merge-base --is-ancestor upstream/master HEAD` detects an already-merged state, and instead of exiting, the script proceeds to the post-merge steps. Before starting a merge, the script records the original HEAD in the private `refs/dsh/upstream-merge-base` ref. A run interrupted by conflicts is completed by rerunning after the manual `git commit` — the merge is skipped, the retained ref keeps the follow-ups tied to the original base, and successful validation deletes it.
- **Post-merge** runs unconditionally and idempotently: re-pin `Dockerfile`'s `ARG DSH_VERSION` to `package.json`'s version, committing it separately when it differs (the merge commit stays a pure merge); `pnpm install` when the merge touched `pnpm-lock.yaml` (detected against the retained private ref, not post-resolution HEAD or reflog arithmetic); `pnpm run typecheck` as the pre-push gate. The script never pushes — the operator reviews and pushes.

## Alternatives considered

**Push at the end, making the script fully hands-off.** Rejected: a merge of hundreds of upstream commits deserves human review between validation and publication; the script prints the push command instead.

**Re-pin DSH_VERSION inside the merge commit (amend).** Rejected: the merge commit is upstream's history plus the merge; a separate `chore(docker)` commit keeps the re-pin visible and revertable on its own.

**Abort the conflicted merge for cleanliness.** Rejected: the conflicted working tree is the operator's workspace for resolution; aborting it throws away in-progress work and the repo's merge driver has already run.

**Run the broader gate suite (doc-sync, tests) inside the script.** Rejected: typecheck is the smallest gate that covers every package surface a merge can break; doc and test gates belong to the push flow, where the operator picks the checks matching the merged diff.

## Consequences

One command performs the documented sync (`./upstream-merge.sh`), matching the docker README's rewritten section, and a conflicted sync names its conflicted files and pairing tool instead of raw git output. The first real run — 536 upstream commits from release 0.1.0-rc.7 to 0.1.0-rc.8 — conflicted in five files (the root README bilingual pair plus its i18n record, and two files from the fork's mobile-sidebar commit); the script exited 1 with the list, the pairs resolved through `pnpm run resolve-translation-pairing-conflicts`, and the rerun re-pinned `DSH_VERSION` to `0.1.0-rc.8`, reinstalled the changed lockfile, and typechecked.

Trade-offs: the script trusts `package.json`'s version as the release to pin (correct while upstream versions the repo and the image together); `pnpm install` only runs when the lockfile changed, so a `packageManager` bump without lockfile churn relies on corepack's own failure; and typecheck is the script's only gate — a merge that breaks documentation or tests is caught by the push flow, not the sync script.

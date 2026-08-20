# Agent Note: run-docker.sh preflights the checkout's install and build state

Status: implemented

English | [中文](2026-08-20-launcher-checkout-preflight.zh.md)

## Problem

The container boots the mounted checkout through its own `pnpm dsh`, which resolves the repository's `node_modules` and its built browser artifacts. `run-docker.sh` validated only that `DSH_REPO` is a directory, so a checkout that was cloned fresh, or pulled past a merge that changed the lockfile or added client packages, reached `docker compose up` and then crashed the `dsh` container seconds later: `dsh web` exits with `client bundles not found; run pnpm run build before launch` (or a module-resolution failure when `node_modules` is missing), the healthcheck never passes, and the user sees only `Container docker-dsh-1 Error dependency...` from Compose — the actual error is buried in container logs the launcher never surfaces. This bit in the field: after merging upstream 0.1.0-rc.8 (which added four client packages), the launcher built the image for two minutes and then failed with no pointer to the cause.

## Decision

The launcher owns the precondition it creates: since it is the component that boots the checkout, it verifies the checkout is bootable before building or starting anything. A single `node -e` preflight right after the `DSH_REPO` existence check tests, in order: `node_modules` present (else "run `pnpm install`"), `apps/web/dist/index.html` present (else "run `pnpm run build`"), and every `packages/client/*` package whose manifest carries a `dsh.client` block has `lib/client.js` (else "run `pnpm run build`", naming the missing packages — exactly the set whose absence crashes the boot). Any finding dies with `error:` naming the repository path and the exact command; a ready checkout prints nothing.

The failure that previously hid in container logs is also surfaced directly: when the loopback proxy does not come up within the readiness window, the launcher now dumps the last 30 lines of the `dsh` service log before dying. The window itself grew from 10 to 45 one-second tries — a cold `pnpm dsh` boot (tsx compiling the checkout) plus the healthcheck gate can exceed 10 seconds on slower machines, which would have produced the same "proxy did not start" dead end without any crash at all.

## Alternatives considered

**Run `pnpm install`/`pnpm run build` automatically when missing.** Rejected: multi-minute side effects on the host tree (network fetch, artifact writes) belong to an explicit user action; the launcher's established pattern is to fail fast with the exact command.

**Only check `node_modules` and let the container error mention the build.** Rejected: the container's error names a command to run inside a directory the user is already in — but discovering it requires reading container logs the launcher never showed, which is the failure being fixed.

**Check a fixed sample bundle (say, `ui-renderer/lib/client.js`).** Rejected: merges can add any number of new client packages; the check must iterate the manifests, not sample one path, or the next merge reintroduces the crash.

**Leave the 10-second probe window.** Rejected as part of the same symptom class: a slow-but-healthy boot would die with the same unhelpful message the crashed boot produced.

## Consequences

A fresh clone now gets `error: <repo> is not ready to boot: run 'pnpm install' there first` before any image build, and a post-merge tree gets the same treatment naming the missing client packages; both are followed by `pnpm install && pnpm run build && ./run-docker.sh` completing normally (verified against the rc.8 merge state on the original machine: pre-merge it reproduced the crash, post-build it serves HTTP 200). The stub-host suite grew to 105 assertions with three new scenarios — no install, no web dist, stale client bundles — plus stub-checkout fixtures for every existing scenario, since the out-of-repo harness previously pointed `DSH_REPO` at empty directories the old launcher accepted.

Trade-offs: the preflight adds one `node` invocation to the launch path (node is already a hard prerequisite); a package.json the preflight cannot parse aborts the launch with the parse error rather than a curated message; and the check treats every `dsh.client` package as required even if a future profile excludes some — a false positive costs one `pnpm run build`, while a false negative costs the original silent crash, so the check errs strict.

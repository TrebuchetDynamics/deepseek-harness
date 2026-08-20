# Agent Note: run-docker.sh preflights the checkout's install and build state

Status: implemented

English | [中文](2026-08-20-launcher-checkout-preflight.zh.md)

## Problem

The container boots the mounted checkout through its own `pnpm dsh`, which resolves the repository's `node_modules` and its built browser artifacts. `run-docker.sh` validated only that `DSH_REPO` is a directory, so a checkout that was cloned fresh, or pulled past a merge that changed the lockfile or added client packages, reached `docker compose up` and then crashed the `dsh` container seconds later: `dsh web` exits with `client bundles not found; run pnpm run build before launch` (or a module-resolution failure when `node_modules` is missing), the healthcheck never passes, and the user sees only `Container docker-dsh-1 Error dependency...` from Compose — the actual error is buried in container logs the launcher never surfaces. This bit in the field: after merging upstream 0.1.0-rc.8 (which added four client packages), the launcher built the image for two minutes and then failed with no pointer to the cause.

## Decision

The launcher owns the precondition it creates: since it is the component that boots the checkout, it verifies the checkout is bootable before building or starting anything. A single `node -e` preflight right after the `DSH_REPO` existence check tests, in order: `node_modules` present (else "run `pnpm install`"), `apps/web/dist/index.html` present (else "run `pnpm run build`"), and every `packages/client/*` package whose manifest carries a `dsh.client` block has `lib/client.js` (else "run `pnpm run build`", naming the missing packages — exactly the set whose absence crashes the boot). Any finding dies with `error:` naming the repository path and the exact command; a ready checkout prints nothing.

Failures hidden behind Compose's dependency message are surfaced directly. When `compose up` fails, the health-gated proxy misses its configurable readiness deadline, or either identity-check request fails, the launcher prints `compose ps -a` and the last 30 lines from both `dsh` and `auth-proxy` before dying; an HTTP-policy mismatch reports both observed status codes. `DSH_STARTUP_TIMEOUT` defaults to 90 seconds so a cold `pnpm dsh` boot plus the 20-second start period and 30-second health interval cannot race a fixed 10-second deadline.

## Alternatives considered

**Run `pnpm install`/`pnpm run build` automatically when missing.** Rejected: multi-minute side effects on the host tree (network fetch, artifact writes) belong to an explicit user action; the launcher's established pattern is to fail fast with the exact command.

**Only check `node_modules` and let the container error mention the build.** Rejected: the container's error names a command to run inside a directory the user is already in — but discovering it requires reading container logs the launcher never showed, which is the failure being fixed.

**Check a fixed sample bundle (say, `ui-renderer/lib/client.js`).** Rejected: merges can add any number of new client packages; the check must iterate the manifests, not sample one path, or the next merge reintroduces the crash.

**Leave the 10-second probe window.** Rejected as part of the same symptom class: a slow-but-healthy boot would die with the same unhelpful message the crashed boot produced.

## Consequences

A fresh clone gets `error: <repo> is not ready to boot: run 'pnpm install' there first` before any image build, and a post-merge tree gets the same treatment naming the missing client packages; after `pnpm install && pnpm run build`, the rc.8 checkout serves HTTP 200. Stub-host scenarios cover no install, no web dist, stale client bundles, failed Compose startup, proxy-policy mismatches, and diagnostics from both services.

Trade-offs: the preflight adds one `node` invocation to the launch path (node is already a hard prerequisite); a package.json the preflight cannot parse aborts the launch with the parse error rather than a curated message; and the check treats every `dsh.client` package as required even if a future profile excludes some — a false positive costs one `pnpm run build`, while a false negative costs the original silent crash, so the check errs strict.

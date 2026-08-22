# Agent Note: run-docker.sh installs and builds the checkout before containers

Status: implemented

English | [中文](2026-08-20-launcher-checkout-preflight.zh.md)

## Problem

The container boots the mounted checkout through its own `pnpm dsh`, which resolves the repository's `node_modules` and built browser artifacts. A fresh checkout or a merge that changes dependencies or client packages can therefore build the container image successfully and then crash at startup with a module-resolution or missing-client-bundle error. Compose reports the health dependency failure while the actionable error remains in the container log.

## Decision

The launcher first validates that `DSH_REPO` is a Git root with a pnpm lockfile and `dsh` package script. It also rejects the known-invalid `web` profile combination that lists both `@linxin666/dsh-web-ui-all` and `dsh-better-sidebar` when the installed aggregate manifest declares that sidebar dependency, providing the exact `dsh plugin remove` command before stopping the existing composition. It then stops the composition before preparing the checkout, so no running process reads dependency links or build artifacts while pnpm replaces them. Every launch then runs `pnpm install --frozen-lockfile` and `pnpm run build` in `DSH_REPO`; either command failing stops the launch with the checkout path. A post-build check requires `node_modules`, `apps/web/dist/index.html`, and `lib/client.js` from every `packages/client/*` manifest carrying `dsh.client`, so a successful custom build that omits runtime assets also fails before Compose startup.

Failures behind Compose's dependency message are surfaced directly. When `compose up` fails, the health-gated proxy misses its configurable readiness deadline, or either identity-check request fails, the launcher prints `compose ps -a` and the last 30 lines from both `dsh` and `auth-proxy` before exiting; an HTTP-policy mismatch reports both observed status codes. `DSH_STARTUP_TIMEOUT` defaults to 90 seconds so a cold `pnpm dsh` boot plus the health-check schedule does not race a short fixed deadline.

## Alternatives considered

**Only report the commands needed by a stale checkout.** Rejected: running a launcher should produce the runnable checkout it requires, and a preflight cannot reliably detect dependency changes from the continued existence of `node_modules`.

**Skip installation when `node_modules` exists.** Rejected: pnpm's lockfile installation is the existing idempotent synchronization mechanism; duplicating part of its freshness logic in shell would be less reliable.

**Trust a zero exit status from the build.** Rejected: `DSH_REPO` is configurable, and its build script may not produce the browser assets consumed by `dsh web`; the narrow artifact check gives that failure before a container restart loop.

## Consequences

One launcher invocation rejects the duplicate sidebar bundle, synchronizes dependencies, rebuilds the checkout, builds the image, starts the composition, validates proxy authorization, and publishes Tailscale Serve. The focused stub-host test verifies that the conflict fails before service shutdown and that checkout installation and compilation precede the image build.

Every launch has downtime while pnpm checks dependencies and compiles sources, and it writes the normal installation and build outputs into the mounted checkout. A failed preparation leaves the existing services stopped. These costs are deliberate: the launcher favors a complete launch over inferring whether a merge left either dependency links or generated assets stale, and it never keeps the old process live against a checkout being rebuilt.

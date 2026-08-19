# Agent Note: Reproducible Docker + CI job for the web browser e2e lane

Status: implemented

English | [中文](2026-08-19-reproducible-browser-e2e-docker.zh.md)

## Problem

The [keyless web browser e2e lane](2026-07-24-web-gui-browser-e2e-lane.md)
(`pnpm run test:web`) drives real Chromium and therefore needs a working
browser renderer plus the OS libraries the lockfile's Playwright Chromium
depends on. A contributor environment — most often a no-root devcontainer —
can have neither, so the lane is unrunnable there even though every other repo
test passes. The native CI gate (`.github/workflows/ci.yml`) provisions Chromium
on its runners, which proves the lane works in CI but gives contributors nothing
to run locally, and nothing exercises a reproducible, prebuilt browser runtime
in CI itself.

## Decision

Phase 1 ships a reproducible Docker runtime plus a dedicated CI job that proves
it. `docker/browser-e2e/` is a toolchain image (node 24-bookworm + pnpm +
`playwright install --with-deps` Chromium at the exact lockfile resolution,
setuid `chrome_sandbox`, Bubblewrap, world-writable `/pnpm-store`). It does not embed a
checkout: `docker/browser-e2e/run.sh` and the CI job bind-mount the repository
read-write at `/workspace` and run `pnpm install --frozen-lockfile && pnpm run
test:web` there. Browser bytes and OS deps are provisioned once into a
`pnpm-lock.yaml`-keyed layer; the workspace install is per run from the current
checkout, so the image stays deterministic without baking in a mutable tree.
The wrapper launches as the caller uid with isolated bridge networking. The full lane requires explicit `--privileged` because its product tests create nested filesystem sandboxes; custom smoke commands remain unprivileged. `--host-network` separately enables access to host-only services.

`.github/workflows/browser-e2e-docker.yml` builds the image and runs the lane keylessly (`DSH_SNAPSHOT=replay`) in a privileged container only after trusted-branch pushes, on schedule, or by explicit dispatch. The native [browser-snapshot CI gate](2026-07-30-web-browser-snapshot-ci-gate.md) remains the pull-request gate.

### Scaffold boundaries

This is a config-and-docs change: it adds the Dockerfile, the run wrapper, the
workflow, the lane README notes, and this record. It changes no product or test
source; in particular it adds no launch knob, so the browser still launches with
the stock `chromium.launch()` sandbox default. The image and wrapper were executed locally. The full lane reached 253 passing browser tests; focused Docker runs verified Bubblewrap-backed jobs and the mobile drawer scenario. Existing conversation-scroll assertions remain owned by their focused lane.

## Alternatives considered

**Official `mcr.microsoft.com/playwright` base image.** Rejected for Phase 1:
the lockfile's Playwright floats on a caret range (`^1.49.0`), so pinning the
official image to a single version either tracks the floating dep (drift) or
pins the repo to a version (churn). Building `install --with-deps` from the real
lockfile keeps the browser exactly aligned with what contributors and the
native gate install, for zero drift cost.

**Image that embeds a full frozen checkout + build.** Rejected: every source
change would force a rebuild, destroying iteration and handing CI a cache miss
on each PR. The bind-mount model reuses the contributor's normal `pnpm install`
flow and keeps node_modules out of the image.

**Reusing the native consumer job for the Docker path.** Rejected: the point is
to prove the *Docker runtime* itself. A separate job is the canary for a broken
Dockerfile, a drifted Playwright/Chromium pair, or a missing OS dep — none of
which the native gate can catch.

**Privileged pull-request job.** Rejected: pull-request code stays on the native browser gate. The privileged Docker canary runs only trusted branch code, and local privilege remains explicit.

## Testing

`docker/browser-e2e/run.sh` runs the lane keylessly in replay mode and fails on
any pageerror or fixture drift, exactly as the native lane does — the lane's own
assertions are the behavioral test, and the container adds none. The CI job
`.github/workflows/browser-e2e-docker.yml` is the reproducible-path validation.
`run.sh` is syntax-clean; the image builds, Chromium launches as the caller uid, the mobile drawer scenario passes, and focused nested-sandbox browser tests pass with explicit privilege.

## Consequences

Contributors on a no-root host gain an explicit privileged command to run the
real-browser lane, and CI independently proves the container image that serves
them. Costs accepted: the image is a separate Chromium provisioning layer from
the native gate (build time on first run, cached thereafter); the bind-mount
run writes `node_modules` into the contributor's checkout (ignored by git,
matching a normal local install); and the full lane grants the container broad kernel capabilities, so it is limited to trusted code and explicit local use.

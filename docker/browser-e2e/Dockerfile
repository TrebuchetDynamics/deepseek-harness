# syntax=docker/dockerfile:1
#
# Reproducible browser-e2e runtime for the web lane (`pnpm run test:web`).
#
# Phase 1 of the Docker/CI e2e lane for the real-browser (Playwright) suite.
# It gives a contributor or CI host whose Chromium rendering is missing or
# whose OS packages are uninstallable (for example a no-root devcontainer) a
# known-good browser that ships exactly the Chromium build the repository's
# lockfile resolves — the same OS-dependency mechanism the hosted CI consumer
# job uses (ci.yml, "Install Playwright Chromium and hosted dependencies").
#
# Build context: the repository root (so the resolution step can read the real
# pnpm-workspace and lockfile). The root .dockerignore keeps credentials,
# node_modules, dist, lib, and docs out of the context.
#
# Run model: the image is a *toolchain* image. It does NOT embed the checkout;
# the `run` wrapper and the CI job bind-mount a checkout read-write at
# /workspace and run `pnpm install --frozen-lockfile && pnpm run test:web`
# there. Provisioning Chromium + OS deps once in the image, then installing the
# workspace per run, is what keeps the image deterministic (browser bytes are a
# build layer keyed to pnpm-lock.yaml) without baking a mutable checkout in.

FROM node:24-bookworm

ARG PNPM_VERSION=11.7.0

# The lane launches stock `chromium.launch()` (the `playwright` package) with
# the default Chromium sandbox. A containerized browser only sandboxes as a
# non-root user when its setuid chrome_sandbox executable is present, so the
# build chmods it 4755 (root-owned, world-executable) — the same fix Playwright's
# own images apply. `run` launches the container with `--user $(id -u):$(id -g)`.
# HOME stays on /tmp (writable by any uid) because Chromium and pnpm write
# caches under it, and node image homes are owned by a fixed uid.

RUN corepack enable \
 && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /src

# Provision from a read-only BuildKit context mount. The checkout is copied to
# a temporary directory, installed without lifecycle scripts, and removed in
# the same layer, so the final image contains browser bytes and OS packages but
# no source tree. Copying the lockfile separately keys this expensive layer to
# dependency resolution rather than unrelated source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=bind,source=.,target=/workspace,ro \
    cp -a /workspace /tmp/dsh-browser-e2e \
 && cd /tmp/dsh-browser-e2e \
 && pnpm install --frozen-lockfile --ignore-scripts \
 && PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
      pnpm --filter @deepseek-ai/dsh-web-frontend exec playwright install --with-deps chromium \
 && apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap \
 && rm -rf /var/lib/apt/lists/* \
 && chmod 4755 /usr/bin/bwrap \
      /opt/ms-playwright/chromium-*/chrome-linux64/chrome_sandbox \
 && rm -rf /tmp/dsh-browser-e2e /root/.local/share/pnpm /root/.npmrc \
 && mkdir -p /pnpm-store \
 && chmod 1777 /pnpm-store

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    PNPM_CONFIG_STORE_DIR=/pnpm-store \
    HOME=/tmp

WORKDIR /workspace

# syntax=docker/dockerfile:1

# DeepSeek Harness, as a container: builds the full monorepo, then runs the
# browser UI (`dsh web`) bound to loopback. When a Tailscale auth key is
# supplied at runtime, the entrypoint also joins the tailnet and serves the UI
# over it (https://<machine>.<tailnet>.ts.net) via `tailscale serve`, keeping
# the Web transport on loopback behind Tailscale's encrypted overlay.
#
# See docker/README.md for usage. This Dockerfile is part of a personal fork
# utility set; it is additive and never changes upstream product code.

# --- build stage: compile the monorepo ---
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 musl-tools \
 && rm -rf /var/lib/apt/lists/*

# pnpm is pinned by the repo's packageManager field; corepack resolves it on demand.
RUN corepack enable

WORKDIR /app

# Copy the repository (.dockerignore keeps build context small).
COPY . .

# Install with scripts disabled: the root postinstall installs lefthook hooks
# (a developer convenience that expects a git worktree we do not ship), and the
# only script-built native the runtime needs is node-pty, rebuilt explicitly.
# Ignoring scripts also keeps the root install side-effect free.
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm rebuild node-pty \
 && pnpm run build \
 && pnpm --filter @deepseek-ai/node-addon-landlock-run-workspace run build:native

# --- runtime stage ---
FROM node:24-bookworm-slim AS runtime

# Match the build stage distro exactly so compiled addons (node-pty, landlock)
# link against the same glibc.
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/

ENV NODE_ENV=production \
    DSH_HOME=/dsh-home \
    HOME=/home/dsh \
    PATH=/usr/local/bin:/usr/bin:/bin

# dsh: uid for the unprivileged harness process. Directories the agent and the
# user data live in are owned by it; tailscaled (started by the entrypoint when
# a key is set) still runs as root in the same process tree.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash curl ca-certificates util-linux git tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 9000 --create-home --home-dir /home/dsh --shell /usr/sbin/nologin dsh \
 && mkdir -p /dsh-home /workspace /var/run/tailscale /var/lib/tailscale \
 && chown -R 9000:9000 /dsh-home /workspace /var/run/tailscale /var/lib/tailscale

COPY --from=build /app /app
COPY docker/dsh-entrypoint.sh /usr/local/bin/dsh-entrypoint.sh

WORKDIR /workspace

# The web route answers index.html on loopback; used only to report container
# readiness. The /api path is what the fence guards, and it stays loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${DSH_PORT:-3080}/ >/dev/null || exit 1

VOLUME ["/dsh-home", "/workspace", "/var/lib/tailscale"]

ENTRYPOINT ["/usr/local/bin/dsh-entrypoint.sh"]

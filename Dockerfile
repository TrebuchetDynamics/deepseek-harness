# syntax=docker/dockerfile:1

# DeepSeek Harness as a container: installs the published dsh CLI from npm and
# runs the browser UI (dsh web) bound to loopback. When TS_AUTHKEY is set, the
# entrypoint also joins the tailnet as its own node and serves :443 over it via
# 'tailscale serve'. The no-key alternative is --network host plus the host's
# own tailscaled doing the serving (see docker/README.md).
#
# DSH_VERSION tracks the fork's pinned release (bump it together with the
# upstream sync). The image uses published packages instead of compiling the
# monorepo, so it stays small and builds quickly even on slow uplinks.

ARG DSH_VERSION=0.1.0-rc.7
ARG PNPM_VERSION=11.7.0

FROM node:24-bookworm-slim AS runtime

# Tailscale binaries for the self-contained tailnet mode (TS_AUTHKEY).
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscaled /usr/local/bin/

ARG DSH_VERSION
ARG PNPM_VERSION
ENV NODE_ENV=production \
    DSH_HOME=/dsh-home \
    HOME=/home/node \
    PATH=/usr/local/bin:/usr/bin:/bin

# The harness runs as the base image's unprivileged 'node' user (uid 1000);
# tailscaled (started by the entrypoint when a key is set) runs as root in this
# same process tree. The build host may sit on a slow or flaky uplink; mirror
# timeouts are transient, so retry the package fetch a few times before giving up.
RUN i=0; until apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates util-linux git tzdata; do \
      i=$((i+1)); [ "$i" -ge 6 ] && { echo "apt-get failed after 6 attempts" >&2; exit 1; }; sleep 15; \
    done \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /dsh-home /workspace /var/run/tailscale /var/lib/tailscale \
 && chown -R 1000:1000 /dsh-home /workspace /var/run/tailscale /var/lib/tailscale /home/node

# The published CLI plus its workspace peers (web-app, web-frontend dist,
# native addons) install as one package; version-pinned to the fork.
# npm 11 blocks install scripts by default; the natives (node-pty terminal,
# koffi LLM client binding, dsh-subprocess-local) need theirs run.
RUN npm install -g --no-audit --no-fund \
      --allow-scripts=node-pty,koffi,@deepseek-ai/dsh-subprocess-local,@google/genai,protobufjs \
      "pnpm@${PNPM_VERSION}" "@deepseek-ai/dsh@${DSH_VERSION}" \
 && rm -rf ~/.npm

# --chmod so the entrypoint stays executable even if the source file's mode is not.
COPY --chmod=755 docker/dsh-entrypoint.sh /usr/local/bin/dsh-entrypoint.sh

WORKDIR /workspace

# The web route answers index.html on loopback; used only to report container
# readiness. The /api path is what the fence guards, and it stays loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${DSH_PORT:-3080}/ >/dev/null || exit 1

VOLUME ["/dsh-home", "/workspace", "/var/lib/tailscale"]

ENTRYPOINT ["/usr/local/bin/dsh-entrypoint.sh"]

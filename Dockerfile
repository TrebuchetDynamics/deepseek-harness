# syntax=docker/dockerfile:1

# DeepSeek Harness as a container: runs the browser UI (dsh web) bound to
# loopback. The entrypoint boots the mounted DeepSeek Harness checkout via its
# own `pnpm dsh` when DSH_REPO is set, so working-tree changes —
# base bundle patches, plugins — take effect on relaunch without a release.
# When TS_AUTHKEY is set, the entrypoint also joins the tailnet as its own node
# and serves :443 over it via 'tailscale serve'. The no-key alternative is
# --network host plus the host's own tailscaled doing the serving (see
# docker/README.md).
#
# DSH_VERSION tracks the fork's pinned release (bump it together with the
# upstream sync). The image installs pnpm and the published CLI; the entrypoint
# boots the checkout via its own `pnpm dsh` when DSH_REPO points at one and
# falls back to the published CLI otherwise, keeping builds small and quick
# even on slow uplinks.

ARG DSH_VERSION=0.1.1-rc.2
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

# OCI annotations; version tracks the pinned release for `docker inspect`.
LABEL org.opencontainers.image.title="DeepSeek Harness" \
      org.opencontainers.image.description="Agent harness container: browser UI behind a Tailscale-identity-aware proxy" \
      org.opencontainers.image.version="${DSH_VERSION}" \
      org.opencontainers.image.source="https://github.com/TrebuchetDynamics/deepseek-harness" \
      org.opencontainers.image.licenses=MIT

# The harness runs as the uid/gid from DSH_UID/DSH_GID (see dsh-entrypoint.sh);
# uid 1000 is only the standalone default. tailscaled (started by the
# entrypoint when a key is set) runs as root in this same process tree. The
# build host may sit on a slow or flaky uplink; mirror timeouts are transient,
# so retry the package fetch a few times before giving up.
# procps supplies ps for PID-reuse checks on persisted plugin locks. Python's
# interpreter, package/venv support, headers, and the native build toolchain
# support repository and agent scripts without borrowing host system files.
RUN i=0; until apt-get update && apt-get install -y --no-install-recommends bash curl ca-certificates util-linux git tzdata procps build-essential pkg-config python3 python-is-python3 python3-dev python3-pip python3-venv; do \
      i=$((i+1)); [ "$i" -ge 6 ] && { echo "apt-get failed after 6 attempts" >&2; exit 1; }; sleep 15; \
    done \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /dsh-home /workspace /var/run/tailscale /var/lib/tailscale \
 && chown -R 1000:1000 /dsh-home /workspace /var/run/tailscale /var/lib/tailscale /home/node

# The published CLI plus its workspace peers (web-app, web-frontend dist,
# native addons) install as one package; version-pinned to the fork.
# npm 11 blocks install scripts by default; the natives (node-pty terminal,
# koffi LLM client binding, dsh-subprocess-local) need theirs run. The cache
# mount keeps the ~90 MB download across rebuilds, including explicit
# no-cache rebuilds, and never enters the image layer.
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --no-audit --no-fund \
      --allow-scripts=node-pty,koffi,@deepseek-ai/dsh-subprocess-local,@google/genai,protobufjs \
      "pnpm@${PNPM_VERSION}" "@deepseek-ai/dsh@${DSH_VERSION}"

# --chmod so the entrypoint stays executable even if the source file's mode is not.
COPY --chmod=755 docker/dsh-entrypoint.sh /usr/local/bin/dsh-entrypoint.sh

WORKDIR /workspace

# The web route answers index.html on loopback; used only to report container
# readiness. The /api path is what the fence guards, and it stays loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${DSH_PORT:-3080}/ >/dev/null || exit 1

# No VOLUME declarations: compose owns state (the tsstate named volume);
# anonymous volumes would silently accumulate on every standalone relaunch.

ENTRYPOINT ["/usr/local/bin/dsh-entrypoint.sh"]

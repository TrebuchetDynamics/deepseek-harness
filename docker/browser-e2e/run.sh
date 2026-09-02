#!/usr/bin/env bash
# Run the web browser e2e lane (`pnpm run test:web`) inside the reproducible
# docker/browser-e2e image, against the current checkout. This is the answer to
# a host whose Chromium is missing or whose OS libraries cannot be installed
# (no root): the image carries the exact lockfile Chromium plus its system deps,
# so contributors never need a working host browser.
#
# The lane owns its persistence roots and disables ambient skill caches. Its
# sandbox tests need nested namespace/mount operations, so the default full-lane
# command requires the explicit `--privileged` flag. Custom commands remain
# unprivileged unless the caller opts in.
#
# Usage:
#   docker/browser-e2e/run.sh [FLAGS] [--] [cmd [args...]]
#
# Flags:
#   --host-network     --network host (container reaches host-only services)
#   --privileged       allow the full lane's nested sandbox backends
#   --                 end of flags; remaining args replace the default command
#   -h|--help          this help
#
# Env honored:
#   DSH_SNAPSHOT   replay (default, keyless) | record | refresh
#   DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL   passed through (record mode)
set -eu

# Repo root is the parent of this script's directory.
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"

RUN_FLAGS=()
HOST_NETWORK=0
PRIVILEGED=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --host-network) HOST_NETWORK=1; shift ;;
    --privileged) PRIVILEGED=1; shift ;;
    --) shift; break ;;
    -*) RUN_FLAGS+=("$1"); shift ;;
    *) break ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker not found on PATH" >&2
  exit 1
fi

IMAGE="dsh-browser-e2e:local"
PNPM_VERSION="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$ROOT/package.json")"
[ -n "$PNPM_VERSION" ] || {
  echo "error: package.json must declare packageManager as pnpm@<version>" >&2
  exit 1
}

# Rebuild only when inputs change; layer caching keeps the pnpm/Chromium
# provisioning layer cheap after the first build.
docker build \
  --build-arg "PNPM_VERSION=${PNPM_VERSION}" \
  -f "$ROOT/docker/browser-e2e/Dockerfile" \
  -t "$IMAGE" \
  "$ROOT"

# Keep container downloads in a caller-owned cache without requiring host pnpm.
STORE_DIR="${XDG_CACHE_HOME:-${HOME:?HOME must be set}/.cache}/deepseek-harness/browser-e2e-pnpm-store"
mkdir -p "$STORE_DIR"

RUN_FLAGS+=(--rm --user "$(id -u):$(id -g)")
RUN_FLAGS+=(--volume "$ROOT:/workspace" --workdir /workspace)
RUN_FLAGS+=(--volume "$STORE_DIR:/tmp/pnpm-store")
RUN_FLAGS+=(--env CI=true)
RUN_FLAGS+=(--env "DSH_SNAPSHOT=${DSH_SNAPSHOT:-replay}")
RUN_FLAGS+=(--env "DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY:-}")
RUN_FLAGS+=(--env "DEEPSEEK_BASE_URL=${DEEPSEEK_BASE_URL:-}")
RUN_FLAGS+=(--env HOME=/tmp)
RUN_FLAGS+=(--env PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright)
RUN_FLAGS+=(--env PNPM_CONFIG_STORE_DIR=/tmp/pnpm-store)

[ "$HOST_NETWORK" -eq 1 ] && RUN_FLAGS+=(--network host)
[ "$PRIVILEGED" -eq 1 ] && RUN_FLAGS+=(--privileged)

# Default command mirrors the CI job: install the resolved workspace, build,
# then run the lane keylessly. Remaining args (after `--`) replace it.
if [ "$#" -eq 0 ]; then
  if [ "$PRIVILEGED" -ne 1 ]; then
    echo "error: the full browser lane exercises nested sandboxes; rerun with --privileged" >&2
    exit 1
  fi
  exec docker run "${RUN_FLAGS[@]}" "$IMAGE" \
    sh -c "pnpm install --frozen-lockfile && pnpm run test:web"
fi

exec docker run "${RUN_FLAGS[@]}" "$IMAGE" "$@"

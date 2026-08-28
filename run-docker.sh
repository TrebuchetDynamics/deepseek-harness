#!/usr/bin/env bash
# Run the containerized Harness behind a Tailscale-identity-aware local proxy.
#
# Host toolchains (Flutter, Android SDK, JDK) are discovered from the host and
# mounted into the container when present; a missing toolchain is a warning
# that removes it from the container, not a launch failure.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$SCRIPT_DIR"
source "$SCRIPT_DIR/scripts/deployment/common.sh"

die() { dsh_die "$@"; exit 1; }
warn() { dsh_warn "$@"; }

[ "$(uname -s)" = Linux ] || die "run-docker.sh requires a Linux host"
# The launcher cannot run without these; every other host dependency degrades.
for tool in node pnpm git curl tailscale flock readlink; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool executable not found on PATH"
done

# --- Container runtime ---------------------------------------------------------
# Auto-selection requires both a Compose frontend and a reachable engine. A
# broken Docker installation therefore cannot mask a working Fedora/podman one.
compose_cmd=()
selected_runtime=""
rootless_podman=0
docker_reason="not found on PATH"
podman_reason="not found on PATH"

select_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  local docker_version
  docker_version="$(docker --version 2>/dev/null || true)"
  if [[ "${docker_version,,}" = *podman* ]]; then
    docker_reason="docker is a podman compatibility shim"
    return 1
  fi
  docker compose version >/dev/null 2>&1 || { docker_reason="Compose plugin unavailable"; return 1; }
  docker info >/dev/null 2>&1 || { docker_reason="engine unreachable or permission denied"; return 1; }
  compose_cmd=(docker compose)
  selected_runtime=docker
  return 0
}

select_podman() {
  command -v podman >/dev/null 2>&1 || return 1
  local rootless
  rootless="$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" || {
    podman_reason="engine unreachable or permission denied"
    return 1
  }
  if podman compose version >/dev/null 2>&1; then
    compose_cmd=(podman compose)
  elif command -v podman-compose >/dev/null 2>&1; then
    compose_cmd=(podman-compose)
  else
    podman_reason="no compose provider; install docker-compose or podman-compose"
    return 1
  fi
  [ "$rootless" = true ] && rootless_podman=1
  selected_runtime=podman
  return 0
}

case "${DSH_CONTAINER_RUNTIME:-auto}" in
  auto)
    select_docker || select_podman || die "no working container runtime (docker: $docker_reason; podman: $podman_reason)"
    ;;
  docker)
    select_docker || die "DSH_CONTAINER_RUNTIME=docker is unavailable: $docker_reason"
    ;;
  podman)
    select_podman || die "DSH_CONTAINER_RUNTIME=podman is unavailable: $podman_reason"
    ;;
  *) die "DSH_CONTAINER_RUNTIME must be auto, docker, or podman" ;;
esac

# Rootless podman maps the host user's uid 1:1 into the container so files
# written to the mounted home keep the host owner. Rootful engines use host
# uids directly.

case "${DSH_BUILD_NO_CACHE:-0}" in
  0) build_args=(); build_cache=enabled ;;
  1) build_args=(--no-cache); build_cache=disabled ;;
  *) die "DSH_BUILD_NO_CACHE must be 0 or 1" ;;
esac

# A selected local Docker runtime is also available to agents by default. Its
# daemon socket grants host-root-equivalent authority; set
# DSH_ENABLE_HOST_DOCKER=0 to retain container-only access. Podman stays off
# because it uses a different socket contract.
host_docker_socket=""
DSH_DOCKER_GID=""
host_docker_default=0
[ "$selected_runtime" = docker ] && host_docker_default=1
case "${DSH_ENABLE_HOST_DOCKER:-$host_docker_default}" in
  0) ;;
  1)
    [ "$selected_runtime" = docker ] || die "DSH_ENABLE_HOST_DOCKER=1 requires the selected runtime to be Docker"
    if [ -n "${DSH_HOST_DOCKER_SOCKET:-}" ]; then
      host_docker_socket="$DSH_HOST_DOCKER_SOCKET"
    else
      if [ -n "${DOCKER_HOST:-}" ]; then
        docker_endpoint="$DOCKER_HOST"
      elif ! docker_endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)"; then
        die "cannot resolve the active Docker context endpoint"
      fi
      case "$docker_endpoint" in
        unix://*) host_docker_socket="${docker_endpoint#unix://}" ;;
        *) die "DSH_ENABLE_HOST_DOCKER=1 requires a local Unix Docker endpoint, got $docker_endpoint" ;;
      esac
    fi
    case "$host_docker_socket" in /*) ;; *) die "Docker socket path must be absolute: $host_docker_socket" ;; esac
    [ -S "$host_docker_socket" ] || die "Docker socket not found: $host_docker_socket"
    DSH_DOCKER_GID="$(stat -c '%g' "$host_docker_socket")" || die "cannot read Docker socket group: $host_docker_socket"
    [[ "$DSH_DOCKER_GID" =~ ^[0-9]+$ ]] || die "Docker socket group is not numeric: $DSH_DOCKER_GID"
    export DSH_DOCKER_GID
    ;;
  *) die "DSH_ENABLE_HOST_DOCKER must be 0 or 1" ;;
esac

echo "container runtime: ${compose_cmd[*]} (build cache: $build_cache)"
if [ -n "$host_docker_socket" ]; then
  echo "host Docker: enabled via $host_docker_socket (root-equivalent daemon access)"
elif [ "$selected_runtime" = docker ]; then
  echo "host Docker: disabled by DSH_ENABLE_HOST_DOCKER=0"
else
  echo "host Docker: unavailable with selected runtime $selected_runtime"
fi

export DSH_PUBLIC_PORT="${DSH_PUBLIC_PORT:-4080}"
export DSH_BACKEND_PORT="${DSH_BACKEND_PORT:-4081}"
# Shared only by the Host and owner-authenticated proxy; a fresh launch token
# prevents clients from forging access to the task-board control routes.
export DSH_TASK_BOARD_PROXY_TOKEN="${DSH_TASK_BOARD_PROXY_TOKEN:-$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")}"
DSH_STARTUP_TIMEOUT="${DSH_STARTUP_TIMEOUT:-90}"
dsh_validate_port DSH_PUBLIC_PORT "$DSH_PUBLIC_PORT"
dsh_validate_port DSH_BACKEND_PORT "$DSH_BACKEND_PORT"
(( 10#$DSH_PUBLIC_PORT != 10#$DSH_BACKEND_PORT )) || die "DSH_PUBLIC_PORT and DSH_BACKEND_PORT must be different"
[[ "$DSH_STARTUP_TIMEOUT" =~ ^[0-9]+$ ]] && (( 10#$DSH_STARTUP_TIMEOUT > 0 )) || die "DSH_STARTUP_TIMEOUT must be a positive integer"
DSH_STARTUP_TIMEOUT=$((10#$DSH_STARTUP_TIMEOUT))

export DSH_HOST_USER_HOME="${DSH_HOST_USER_HOME:-$HOME}"
[ -d "$DSH_HOST_USER_HOME" ] || die "host home directory not found: $DSH_HOST_USER_HOME"
# Docker and native deployment mutate the same checkout and Tailscale route.
dsh_acquire_deployment_lock "$DSH_HOST_USER_HOME"
# The container drops to the host home's owner so files the agent creates in
# the mounted home belong to the invoking user on the host (Fedora users are
# commonly not uid 1000).
if home_owner="$(stat -c '%u %g' "$DSH_HOST_USER_HOME" 2>/dev/null)"; then
  read -r DSH_UID DSH_GID <<<"$home_owner"
else
  DSH_UID="$(id -u)"
  DSH_GID="$(id -g)"
  warn "cannot read owner of $DSH_HOST_USER_HOME; assuming invoking user (uid=$DSH_UID gid=$DSH_GID)"
fi
export DSH_UID DSH_GID
# Boot the checkout this script lives in, not the published @deepseek-ai/dsh:
# the container entrypoint runs ${DSH_REPO}'s `pnpm dsh`, so working-tree changes
# (base bundle, plugins) take effect on relaunch without an npm release.
export DSH_REPO="${DSH_REPO:-$PWD}"
[ -d "$DSH_REPO" ] || die "repository directory not found: $DSH_REPO"
if ! repo_root="$(git -C "$DSH_REPO" rev-parse --show-toplevel 2>/dev/null)" \
    || [ "$(readlink -f "$repo_root")" != "$(readlink -f "$DSH_REPO")" ]; then
  die "DSH_REPO must be the root of a Git checkout: $DSH_REPO"
fi
[ -f "$DSH_REPO/pnpm-lock.yaml" ] || die "pnpm lockfile not found: $DSH_REPO/pnpm-lock.yaml"
if ! node -e 'const p = require(process.argv[1]); process.exit(typeof p.scripts?.dsh === "string" ? 0 : 1)' "$DSH_REPO/package.json"; then
  die "package.json has no dsh script: $DSH_REPO/package.json"
fi

# Reject the known duplicate sidebar composition before stopping services.
if ! profile_check="$(dsh_reject_duplicate_sidebar "$DSH_HOST_USER_HOME" 2>&1)"; then
  die "$profile_check"
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet deepseek-harness.service; then
  die "deepseek-harness.service is active; run ./start.sh stop before Docker deployment"
fi

# The running container reads this checkout directly. Stop it before pnpm
# replaces dependency links and build artifacts, then prepare the next launch.
if ! "${compose_cmd[@]}" -f docker/docker-compose.yml stop dsh auth-proxy; then
  die "failed to stop the existing composition before rebuilding $DSH_REPO"
fi
echo "preparing checkout: $DSH_REPO"
dsh_prepare_checkout "$DSH_REPO" pnpm

# --- Optional host toolchains -------------------------------------------------
# Each discovery leaves DSH_HOST_*_HOME empty when the toolchain is absent:
# an empty value drops the container mount, the PATH entry, and the entrypoint
# symlink instead of failing the launch.

# Flutter: the SDK root sits two directories above the flutter executable.
export DSH_HOST_FLUTTER_HOME="${DSH_HOST_FLUTTER_HOME:-}"
if [ -n "$DSH_HOST_FLUTTER_HOME" ] || flutter_bin="$(command -v flutter)"; then
  [ -n "$DSH_HOST_FLUTTER_HOME" ] || DSH_HOST_FLUTTER_HOME="$(dirname "$(dirname "$(readlink -f "$flutter_bin")")")"
  if [ ! -x "$DSH_HOST_FLUTTER_HOME/bin/flutter" ]; then
    warn "Flutter executable not found at $DSH_HOST_FLUTTER_HOME; continuing without Flutter"
    DSH_HOST_FLUTTER_HOME=""
  fi
else
  warn "no Flutter executable on PATH; continuing without Flutter"
fi

# Android SDK: the DSH_HOST_ANDROID_HOME override when set (skipped with a
# warning when it lacks platform-tools/adb), else the first of the ambient
# variables and typical install locations that provides platform-tools/adb.
# Ambient variables are treated as hints: an invalid one falls through to the
# next candidate, while the explicit override is an instruction and only warns.
export DSH_HOST_ANDROID_HOME="${DSH_HOST_ANDROID_HOME:-}"
if [ -n "$DSH_HOST_ANDROID_HOME" ]; then
  if [ -x "$DSH_HOST_ANDROID_HOME/platform-tools/adb" ]; then
    DSH_HOST_ANDROID_HOME="$(readlink -f "$DSH_HOST_ANDROID_HOME")"
  else
    warn "DSH_HOST_ANDROID_HOME has no platform-tools/adb; continuing without the Android SDK"
    DSH_HOST_ANDROID_HOME=""
  fi
else
  for candidate in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" \
      "$DSH_HOST_USER_HOME/Android/Sdk" "$DSH_HOST_USER_HOME/android-sdk" \
      /usr/lib/android-sdk /opt/android-sdk; do
    [ -n "$candidate" ] || continue
    [ -x "$candidate/platform-tools/adb" ] || continue
    DSH_HOST_ANDROID_HOME="$(readlink -f "$candidate")"
    break
  done
  [ -n "$DSH_HOST_ANDROID_HOME" ] || warn "no Android SDK found (checked \$ANDROID_HOME, \$ANDROID_SDK_ROOT, ~/Android/Sdk, ~/android-sdk, /usr/lib/android-sdk, /opt/android-sdk); continuing without adb"
fi

# Java: the JDK root sits two directories above the java executable.
export DSH_HOST_JAVA_HOME="${DSH_HOST_JAVA_HOME:-}"
if [ -n "$DSH_HOST_JAVA_HOME" ] || java_bin="$(command -v java)"; then
  [ -n "$DSH_HOST_JAVA_HOME" ] || DSH_HOST_JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$java_bin")")")"
  if [ ! -x "$DSH_HOST_JAVA_HOME/bin/java" ]; then
    warn "Java executable not found at $DSH_HOST_JAVA_HOME; continuing without Java"
    DSH_HOST_JAVA_HOME=""
  fi
else
  warn "no Java executable on PATH; continuing without Java"
fi

# The agent's working directory inside the container: the host repositories
# directory when it exists, else the mounted home itself.
export DSH_HOST_WORKSPACE="${DSH_HOST_WORKSPACE:-$DSH_HOST_USER_HOME/git}"
if [ ! -d "$DSH_HOST_WORKSPACE" ]; then
  warn "workspace directory not found: $DSH_HOST_WORKSPACE; using $DSH_HOST_USER_HOME"
  export DSH_HOST_WORKSPACE="$DSH_HOST_USER_HOME"
fi

echo "host toolchains: flutter=${DSH_HOST_FLUTTER_HOME:-none} android=${DSH_HOST_ANDROID_HOME:-none} java=${DSH_HOST_JAVA_HOME:-none}"

dsh_load_tailscale_identity
magicdns="$DSH_MAGICDNS"
tailnet_ip="$DSH_TAILSCALE_IP"
# Both the MagicDNS name and the raw tailnet IPv4 must pass the Harness browser
# trust checks; an IP-based request carries the address as its Host value.
export DSH_TRUSTED_HOSTS="${magicdns}${tailnet_ip:+ ${tailnet_ip}}${DSH_TRUSTED_HOSTS:+ ${DSH_TRUSTED_HOSTS}}"

# Compose cannot express "mount this only when it exists on the host": a bind
# mount of a missing path makes the Docker daemon create an empty root-owned
# directory. Optional mounts therefore go into a generated per-launch override
# file; the base compose file keeps only the mounts every host provides. The
# same file carries the rootless-podman keep-id mapping.
override_dir="$(mktemp -d)"
override_file="$override_dir/docker-compose.host.yml"
trap 'rm -rf "$override_dir"' EXIT

host_volumes=""
add_host_volume() { host_volumes+="      - $1"$'\n'; }

# Paths outside the mounted host home are invisible in the container without
# an explicit mount at the same path; empty paths never mount.
needs_mount() {
  [ -n "$1" ] || return 1
  case "$1" in "$DSH_HOST_USER_HOME"/*) return 1 ;; *) return 0 ;; esac
}

# The JDK stays read-only so the agent cannot modify it; Flutter, the Android
# SDK, and the repository mount writable, matching the home mount.
[ -n "$DSH_HOST_JAVA_HOME" ] && add_host_volume "$DSH_HOST_JAVA_HOME:$DSH_HOST_JAVA_HOME:ro"
needs_mount "$DSH_HOST_ANDROID_HOME" && add_host_volume "$DSH_HOST_ANDROID_HOME:$DSH_HOST_ANDROID_HOME"
needs_mount "$DSH_HOST_FLUTTER_HOME" && add_host_volume "$DSH_HOST_FLUTTER_HOME:$DSH_HOST_FLUTTER_HOME"
needs_mount "$DSH_REPO" && add_host_volume "$DSH_REPO:$DSH_REPO"
# Android device access: udev state and the USB bus, when the host has them.
[ -d /run/udev ] && add_host_volume "/run/udev:/run/udev:ro"
[ -d /dev/bus/usb ] && add_host_volume "/dev/bus/usb:/dev/bus/usb"
[ -n "$host_docker_socket" ] && add_host_volume "$host_docker_socket:/var/run/docker.sock"

compose_files=(-f docker/docker-compose.yml)
# keep-id is a podman-only value; Docker's daemon rejects it at run time, so it
# reaches Compose only through this generated override, never the base file.
dsh_override=""
[ "$rootless_podman" = 1 ] && dsh_override+="    userns_mode: keep-id"$'\n'
if [ -n "$host_docker_socket" ]; then
  dsh_override+="    environment:"$'\n'
  dsh_override+="      - DOCKER_HOST=unix:///var/run/docker.sock"$'\n'
  dsh_override+="      - DSH_DOCKER_GID=$DSH_DOCKER_GID"$'\n'
fi
if [ -n "$host_volumes" ] || [ -n "$dsh_override" ]; then
  {
    echo "# Generated by run-docker.sh: optional host-specific mounts and runtime mapping."
    printf 'services:\n  dsh:\n'
    [ -n "$dsh_override" ] && printf '%s' "$dsh_override"
    [ -n "$host_volumes" ] && printf '    volumes:\n%s' "$host_volumes"
  } >"$override_file"
  compose_files+=(-f "$override_file")
fi

diagnose_stack() {
  echo "--- compose service state ---" >&2
  "${compose_cmd[@]}" "${compose_files[@]}" ps -a >&2 || true
  echo "--- recent dsh/auth-proxy logs ---" >&2
  "${compose_cmd[@]}" "${compose_files[@]}" logs --tail 30 dsh auth-proxy >&2 || true
}

if ! "${compose_cmd[@]}" "${compose_files[@]}" build "${build_args[@]}"; then
  die "container image build failed"
fi
if ! "${compose_cmd[@]}" "${compose_files[@]}" up -d --force-recreate --remove-orphans "$@"; then
  diagnose_stack
  die "composition failed to start"
fi
proxy="http://127.0.0.1:${DSH_PUBLIC_PORT}"
proxy_ready=
startup_deadline=$((SECONDS + DSH_STARTUP_TIMEOUT))
# The auth-proxy binds only after the dsh healthcheck passes, and a cold
# `pnpm dsh` boot (tsx compiling the checkout) can take tens of seconds.
while (( SECONDS < startup_deadline )); do
  if curl -sS -o /dev/null "$proxy/" 2>/dev/null; then proxy_ready=1; break; fi
  sleep 1
done
if [ -z "$proxy_ready" ]; then
  diagnose_stack
  die "proxy did not start at $proxy within ${DSH_STARTUP_TIMEOUT}s"
fi
launch_url=
while (( SECONDS < startup_deadline )); do
  launch_url="$("${compose_cmd[@]}" "${compose_files[@]}" logs --no-color dsh 2>/dev/null \
    | grep -Eo 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' | tail -n1 || true)"
  [ -z "$launch_url" ] || break
  sleep 1
done
[ -n "$launch_url" ] || {
  diagnose_stack
  die "Harness container did not publish a launch URL"
}
if ! proxy_check="$(dsh_probe_identity_proxy "$proxy" "$magicdns" "$TAILSCALE_OWNER" "$launch_url" "$startup_deadline" 2>&1)"; then
  diagnose_stack
  printf '%s\n' "$proxy_check" >&2
  exit 1
fi

tailscale serve --tcp=80 off >/dev/null 2>&1 || true
tailscale serve --yes --bg --https=443 "$proxy" || die "failed to publish $proxy with Tailscale Serve"
echo "Web UI: https://$magicdns/?token=${launch_url#*\?token=}"

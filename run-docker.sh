#!/usr/bin/env bash
# Run the containerized Harness behind a Tailscale-identity-aware local proxy.
#
# Host toolchains (Flutter, Android SDK, JDK) are discovered from the host and
# mounted into the container when present; a missing toolchain is a warning
# that removes it from the container, not a launch failure.
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

[ "$(uname -s)" = Linux ] || die "run-docker.sh requires a Linux host"
# The launcher cannot run without these; every other host dependency degrades.
for tool in node curl tailscale flock readlink; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool executable not found on PATH"
done

# Compose recreation uses temporary container names, so concurrent launches conflict.
exec 9<"$0"
flock 9

# --- Container runtime ---------------------------------------------------------
# Auto-selection requires both a Compose frontend and a reachable engine. A
# broken Docker installation therefore cannot mask a working Fedora/podman one.
compose_cmd=()
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

echo "container runtime: ${compose_cmd[*]} (build cache: $build_cache)"

export DSH_PUBLIC_PORT="${DSH_PUBLIC_PORT:-4080}"
export DSH_BACKEND_PORT="${DSH_BACKEND_PORT:-4081}"
# Shared only by the Host and owner-authenticated proxy; a fresh launch token
# prevents clients from forging access to the task-board control routes.
export DSH_TASK_BOARD_PROXY_TOKEN="${DSH_TASK_BOARD_PROXY_TOKEN:-$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")}"
DSH_STARTUP_TIMEOUT="${DSH_STARTUP_TIMEOUT:-90}"
validate_port() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] && (( 10#$value >= 1 && 10#$value <= 65535 )) || die "$name must be an integer from 1 to 65535"
}
validate_port DSH_PUBLIC_PORT "$DSH_PUBLIC_PORT"
validate_port DSH_BACKEND_PORT "$DSH_BACKEND_PORT"
(( 10#$DSH_PUBLIC_PORT != 10#$DSH_BACKEND_PORT )) || die "DSH_PUBLIC_PORT and DSH_BACKEND_PORT must be different"
[[ "$DSH_STARTUP_TIMEOUT" =~ ^[0-9]+$ ]] && (( 10#$DSH_STARTUP_TIMEOUT > 0 )) || die "DSH_STARTUP_TIMEOUT must be a positive integer"
DSH_STARTUP_TIMEOUT=$((10#$DSH_STARTUP_TIMEOUT))

export DSH_HOST_USER_HOME="${DSH_HOST_USER_HOME:-$HOME}"
[ -d "$DSH_HOST_USER_HOME" ] || die "host home directory not found: $DSH_HOST_USER_HOME"
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

# The container boots this checkout via its own `pnpm dsh`, which resolves the
# repository's installed modules and built browser artifacts. A fresh clone or
# a freshly merged tree without them crashes the container at startup, so fail
# here with the exact command instead. Prints the missing step, if any.
preflight="$(node -e '
const fs = require("node:fs"), path = require("node:path")
const repo = process.argv[1]
if (!fs.existsSync(path.join(repo, "node_modules"))) { console.log("pnpm install"); process.exit(0) }
if (!fs.existsSync(path.join(repo, "apps/web/dist/index.html"))) { console.log("pnpm run build (web frontend missing)"); process.exit(0) }
const missing = []
for (const dir of fs.readdirSync(path.join(repo, "packages/client"))) {
  const pkg = path.join(repo, "packages/client", dir)
  const manifest = path.join(pkg, "package.json")
  if (!fs.existsSync(manifest)) continue
  const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"))
  if (parsed.dsh?.client && !fs.existsSync(path.join(pkg, "lib/client.js"))) missing.push(dir)
}
if (missing.length > 0) console.log(`pnpm run build (client bundles missing: ${missing.join(", ")})`)
' "$DSH_REPO")"
[ -z "$preflight" ] || die "$DSH_REPO is not ready to boot: run '$preflight' there first"

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

if ! tailscale_status="$(tailscale status --json 2>/dev/null)"; then
  die "Tailscale status unavailable; connect this host with 'tailscale up'"
fi
if ! tailnet_output="$(printf '%s' "$tailscale_status" | node -e '
let s = ""
process.stdin.on("data", d => { s += d }).on("end", () => {
  const status = JSON.parse(s)
  console.log((status.Self?.DNSName ?? "").replace(/\.$/, ""))
  console.log(status.User?.[String(status.Self?.UserID)]?.LoginName ?? "")
})')"; then
  die "Tailscale returned invalid status JSON"
fi
readarray -t tailnet <<<"$tailnet_output"
magicdns="${tailnet[0]:-}"
export TAILSCALE_OWNER="${TAILSCALE_OWNER:-${tailnet[1]:-}}"
[ -n "$magicdns" ] || die "Tailscale MagicDNS name unavailable"
[ -n "$TAILSCALE_OWNER" ] || die "Tailscale owner login unavailable"
# Both the MagicDNS name and the raw tailnet IPv4 must pass the harness
# browser-trust fences (/api and the sidebar plugin's /sidebar routes): a
# browser reaching the GUI over the bare tailnet address carries the IP as
# its Host, not the DNS name.
tailnet_ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
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

compose_files=(-f docker/docker-compose.yml)
# keep-id is a podman-only value; Docker's daemon rejects it at run time, so it
# reaches Compose only through this generated override, never the base file.
dsh_override=""
[ "$rootless_podman" = 1 ] && dsh_override="    userns_mode: keep-id"$'\n'
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
# The auth-proxy binds only after the dsh healthcheck passes, and a cold
# `pnpm dsh` boot (tsx compiling the checkout) can take tens of seconds.
for ((attempt = 0; attempt < DSH_STARTUP_TIMEOUT; attempt++)); do
  if curl -fsS -o /dev/null "$proxy/" 2>/dev/null; then proxy_ready=1; break; fi
  sleep 1
done
if [ -z "$proxy_ready" ]; then
  diagnose_stack
  die "proxy did not start at $proxy within ${DSH_STARTUP_TIMEOUT}s"
fi
probe=( -sS -o /dev/null -w '%{http_code}' -X POST "$proxy/api/settings.describe" -H "Host: $magicdns" -H "Origin: https://$magicdns" -H 'content-type: application/json' --data '{}' )
if ! denied="$(curl "${probe[@]}" -H 'Tailscale-User-Login: unauthorized@example.invalid')"; then
  diagnose_stack
  die "Tailscale identity proxy self-check request failed for the unauthorized identity"
fi
if ! allowed="$(curl "${probe[@]}" -H "Tailscale-User-Login: $TAILSCALE_OWNER")"; then
  diagnose_stack
  die "Tailscale identity proxy self-check request failed for $TAILSCALE_OWNER"
fi
if [ "$denied" != 403 ] || [ "$allowed" != 200 ]; then
  diagnose_stack
  die "Tailscale identity proxy self-check failed (denied=$denied, allowed=$allowed)"
fi

tailscale serve --tcp=80 off >/dev/null 2>&1 || true
tailscale serve --yes --bg --https=443 "$proxy" || die "failed to publish $proxy with Tailscale Serve"

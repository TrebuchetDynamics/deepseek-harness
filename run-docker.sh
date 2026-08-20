#!/usr/bin/env bash
# Run the containerized Harness behind a Tailscale-identity-aware local proxy.
#
# Host toolchains (Flutter, Android SDK, JDK) are discovered from the host and
# mounted into the container when present; a missing toolchain is a warning
# that removes it from the container, not a launch failure.
set -euo pipefail
cd "$(dirname "$0")"

# Compose recreation uses temporary container names, so concurrent launches conflict.
exec 9<"$0"
flock 9

die() { echo "error: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

# The launcher cannot run without these; every other host dependency degrades.
for tool in node curl tailscale; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool executable not found on PATH"
done

# --- Container runtime ---------------------------------------------------------
# Docker when present, else podman with a compose provider (the Fedora
# default). `podman compose` delegates to docker-compose or podman-compose,
# whichever is installed; the legacy podman-compose wrapper is the last resort.
compose_cmd=()
if command -v docker >/dev/null 2>&1; then
  compose_cmd=(docker compose)
elif command -v podman >/dev/null 2>&1; then
  if podman compose version >/dev/null 2>&1; then
    compose_cmd=(podman compose)
  elif command -v podman-compose >/dev/null 2>&1; then
    compose_cmd=(podman-compose)
  else
    die "podman found but no compose provider; install docker-compose or podman-compose"
  fi
elif command -v podman-compose >/dev/null 2>&1; then
  compose_cmd=(podman-compose)
else
  die "no container runtime found: install docker, or podman plus a compose provider"
fi

# Rootless podman maps container uids through a user namespace; keep-id maps
# the host user's uid 1:1 into the container so files written to the mounted
# home keep the host owner. Rootful podman and Docker use host uids directly.
rootless_podman=0
if [ "${compose_cmd[0]}" = podman ] || [ "${compose_cmd[0]}" = podman-compose ]; then
  [ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null || true)" = true ] && rootless_podman=1
fi

export DSH_PUBLIC_PORT="${DSH_PUBLIC_PORT:-4080}"
export DSH_BACKEND_PORT="${DSH_BACKEND_PORT:-4081}"
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

readarray -t tailnet < <(tailscale status --json | node -e '
let s = ""
process.stdin.on("data", d => { s += d }).on("end", () => {
  const status = JSON.parse(s)
  console.log((status.Self?.DNSName ?? "").replace(/\.$/, ""))
  console.log(status.User?.[String(status.Self?.UserID)]?.LoginName ?? "")
})')
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

"${compose_cmd[@]}" "${compose_files[@]}" build --no-cache
"${compose_cmd[@]}" "${compose_files[@]}" up -d --force-recreate "$@"
proxy="http://127.0.0.1:${DSH_PUBLIC_PORT}"
proxy_ready=
for _ in {1..10}; do
  if curl -fsS -o /dev/null "$proxy/" 2>/dev/null; then proxy_ready=1; break; fi
  sleep 1
done
[ -n "$proxy_ready" ] || die "proxy did not start at $proxy"
probe=( -sS -o /dev/null -w '%{http_code}' -X POST "$proxy/api/settings.describe" -H "Host: $magicdns" -H "Origin: https://$magicdns" -H 'content-type: application/json' --data '{}' )
denied="$(curl "${probe[@]}" -H 'Tailscale-User-Login: unauthorized@example.invalid')"
allowed="$(curl "${probe[@]}" -H "Tailscale-User-Login: $TAILSCALE_OWNER")"
[ "$denied" = 403 ] && [ "$allowed" = 200 ] || die "Tailscale identity proxy self-check failed"

tailscale serve --tcp=80 off >/dev/null 2>&1 || true
tailscale serve --yes --bg --https=443 "$proxy"

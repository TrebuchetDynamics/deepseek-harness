#!/usr/bin/env bash
#
# DeepSeek Harness container entrypoint.
#
# Runs the browser UI (dsh web) bound to loopback. When TS_AUTHKEY is set, it
# first joins the Tailscale tailnet, serves :443 over the tailnet via 'tailscale
# serve', and passes the tailnet hostname to 'dsh --trusted-host' so the /api
# browser-trust fence accepts the browser's requests. Without a key it runs the
# UI on loopback only (reachable from the host via docker exec).
#
# Environment (all optional unless noted):
#   TS_AUTHKEY        Tailscale auth key enabling tailnet serving
#   TS_HOSTNAME       desired tailscale machine name (default: container id)
#   TS_EXTRA_ARGS     extra arguments for 'tailscale up' (e.g. --advertise-tags)
#   TS_USERSPACE      1 (default) userspace networking, no NET_ADMIN or /dev/net/tun
#                     0 prefers the kernel tun when /dev/net/tun exists
#   DSH_PORT          web UI listen port (default 3080)
#   DSH_WORKSPACE     agent working directory (default /workspace)
#   DSH_REPO          optional DeepSeek Harness checkout to boot via its own
#                     `pnpm dsh`; otherwise use the published CLI
#   DSH_TRUSTED_HOSTS extra /api authorities (space or comma separated),
#                     appended to the derived tailnet hostname
#   DSH_UID           uid the harness drops to (default 1000)
#   DSH_GID           gid the harness drops to (default 1000)
#
# The application runs as the uid/gid given by DSH_UID/DSH_GID (run-docker.sh
# sets them to the host home's owner, which need not match the image's 'node'
# user); tailscaled (started when a key is set) runs as root in this same
# process tree.
set -euo pipefail

DSH_PORT="${DSH_PORT:-3080}"
DSH_WORKSPACE="${DSH_WORKSPACE:-/workspace}"
DSH_UID="${DSH_UID:-1000}"
DSH_GID="${DSH_GID:-1000}"
TAILSCALE_STATE_DIR="${TAILSCALE_STATE_DIR:-/var/lib/tailscale}"
TAILSCALE_SOCKET="/var/run/tailscale/tailscaled.sock"

DSH_ARGS=(web --port "$DSH_PORT")
TRUSTED_HOSTS=()

join_tailnet() {
  local ts_args=(--state="$TAILSCALE_STATE_DIR/tailscaled.state" --socket="$TAILSCALE_SOCKET")

  # Userspace networking is the reliable unprivileged default (no NET_ADMIN or
  # /dev/net/tun); kernel tun when explicitly requested and possible.
  if [[ "${TS_USERSPACE:-1}" != "1" ]] && [[ -e /dev/net/tun ]]; then
    ts_args+=(--tun=default)   # kernel tun
  else
    ts_args+=(--tun=userspace-networking)
  fi
  tailscaled "${ts_args[@]}" &
  local tailscaled_pid=$!
  trap 'kill "$tailscaled_pid" 2>/dev/null || true' EXIT

  # Wait for the local API socket before talking to the CLI.
  local i
  for (( i = 0; i < 120; i++ )); do
    [[ -S "$TAILSCALE_SOCKET" ]] && break
    sleep 0.5
  done
  [[ -S "$TAILSCALE_SOCKET" ]] || { echo "tailscaled: local API socket never appeared" >&2; exit 1; }

  local up_args=()
  [[ -n "${TS_HOSTNAME:-}" ]] && up_args+=(--hostname="$TS_HOSTNAME")
  # Word-split EXTRA_ARGS on purpose: it is a user-provided shell arg string.
  # shellcheck disable=SC2086
  tailscale --socket="$TAILSCALE_SOCKET" up --authkey="$TS_AUTHKEY" "${up_args[@]}" ${TS_EXTRA_ARGS:-}

  # Wait until the node owns a MagicDNS name, then strip the trailing dot it
  # reports. A port-less authority 'name.tailnet.ts.net' matches any port in
  # the /api fence, which is what we need behind :443.
  local self_dns=""
  for (( i = 0; i < 120; i++ )); do
    self_dns=$(tailscale --socket="$TAILSCALE_SOCKET" status --json 2>/dev/null \
      | sed -n 's/.*"DNSName":"\([^"]*\)".*/\1/p')
    [[ -n "$self_dns" ]] && break
    sleep 1
  done
  self_dns="${self_dns%.}"
  [[ -n "$self_dns" ]] || { echo "tailscale: no tailnet hostname after login" >&2; exit 1; }

  TRUSTED_HOSTS+=("$self_dns")
  # Keeps the original Host header (do not rewrite): the fence compares Origin
  # to Host, so both must be the real tailnet name.
  tailscale --socket="$TAILSCALE_SOCKET" serve --bg --https=443 "http://127.0.0.1:$DSH_PORT"
  echo "dsh over Tailscale: https://$self_dns/"
}

# Tailscale state dirs were chowned to the image's uid 1000 at build time; the
# runtime user may differ, and only root (this shell) can fix ownership. Before
# join_tailnet so tailscaled creates its files with the intended owner.
[[ -d /var/run/tailscale ]] && chown -R "$DSH_UID:$DSH_GID" /var/run/tailscale
[[ -d "$TAILSCALE_STATE_DIR" ]] && chown -R "$DSH_UID:$DSH_GID" "$TAILSCALE_STATE_DIR"

if [[ -n "${TS_AUTHKEY:-}" ]]; then
  join_tailnet
fi

# Additional authorities the user knows it is reached by (e.g. a CNAME'd
# tailscale name) extend the fence next to the derived tailnet hostname.
IFS=' ,' read -r -a extra <<< "${DSH_TRUSTED_HOSTS:-}"
trusted=("${TRUSTED_HOSTS[@]}" "${extra[@]}")
for h in "${trusted[@]}"; do
  [[ -n "$h" ]] && DSH_ARGS+=(--trusted-host "$h")
done

# Login shells reset PATH, so expose mounted host toolchains through the
# container's standard executable directory.
[[ -x "${FLUTTER_ROOT:-}/bin/flutter" ]] && ln -sf "$FLUTTER_ROOT/bin/flutter" /usr/local/bin/flutter
[[ -x "${FLUTTER_ROOT:-}/bin/dart" ]] && ln -sf "$FLUTTER_ROOT/bin/dart" /usr/local/bin/dart
[[ -x "${ANDROID_HOME:-}/platform-tools/adb" ]] && ln -sf "$ANDROID_HOME/platform-tools/adb" /usr/local/bin/adb
[[ -x "${JAVA_HOME:-}/bin/java" ]] && ln -sf "$JAVA_HOME/bin/java" /usr/local/bin/java

# Boot the checkout when DSH_REPO points at one (its root package.json runs a
# `dsh` script); otherwise fall back to the published CLI.
if [[ -n "${DSH_REPO:-}" ]] && [[ -f "$DSH_REPO/package.json" ]] \
  && grep -qE '"dsh"[[:space:]]*:' "$DSH_REPO/package.json"; then
  cd "$DSH_REPO"
  DSH_LAUNCH=(pnpm dsh)
else
  cd "$DSH_WORKSPACE"
  DSH_LAUNCH=(dsh)
fi

echo "dsh web on http://127.0.0.1:$DSH_PORT (loopback) from $(pwd) as uid=$DSH_UID gid=$DSH_GID"
# --clear-groups (not --init-groups): DSH_UID usually has no passwd entry in
# the image, and supplementary groups are not needed to write the mounted home.
exec setpriv --reuid="$DSH_UID" --regid="$DSH_GID" --clear-groups \
  "${DSH_LAUNCH[@]}" "${DSH_ARGS[@]}"

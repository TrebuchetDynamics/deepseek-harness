#!/usr/bin/env bash
# Run the containerized Harness behind a Tailscale-identity-aware local proxy.
set -euo pipefail
cd "$(dirname "$0")"

# Compose recreation uses temporary container names, so concurrent launches conflict.
exec 9<"$0"
flock 9

export DSH_PUBLIC_PORT="${DSH_PUBLIC_PORT:-4080}"
export DSH_BACKEND_PORT="${DSH_BACKEND_PORT:-4081}"
export DSH_HOST_USER_HOME="${DSH_HOST_USER_HOME:-$HOME}"
[ -d "$DSH_HOST_USER_HOME/git" ] || { echo "error: repository directory not found: $DSH_HOST_USER_HOME/git" >&2; exit 1; }
if [ -z "${DSH_HOST_FLUTTER_HOME:-}" ]; then
  flutter_bin="$(command -v flutter)" || { echo "error: Flutter executable not found on PATH" >&2; exit 1; }
  export DSH_HOST_FLUTTER_HOME="$(dirname "$(dirname "$(readlink -f "$flutter_bin")")")"
fi
[ -x "$DSH_HOST_FLUTTER_HOME/bin/flutter" ] || { echo "error: Flutter SDK not found: $DSH_HOST_FLUTTER_HOME" >&2; exit 1; }
[ -x /usr/lib/android-sdk/platform-tools/adb ] || { echo "error: Android SDK not found under /usr/lib/android-sdk" >&2; exit 1; }
if [ -z "${DSH_HOST_JAVA_HOME:-}" ]; then
  java_bin="$(command -v java)" || { echo "error: Java executable not found" >&2; exit 1; }
  java_path="$(readlink -f "$java_bin")"
  export DSH_HOST_JAVA_HOME="$(dirname "$(dirname "$java_path")")"
fi
[ -x "$DSH_HOST_JAVA_HOME/bin/java" ] || { echo "error: Java SDK not found: $DSH_HOST_JAVA_HOME" >&2; exit 1; }

readarray -t tailnet < <(tailscale status --json | node -e '
let s = ""
process.stdin.on("data", d => { s += d }).on("end", () => {
  const status = JSON.parse(s)
  console.log((status.Self?.DNSName ?? "").replace(/\.$/, ""))
  console.log(status.User?.[String(status.Self?.UserID)]?.LoginName ?? "")
})')
magicdns="${tailnet[0]:-}"
export TAILSCALE_OWNER="${TAILSCALE_OWNER:-${tailnet[1]:-}}"
[ -n "$magicdns" ] || { echo "error: Tailscale MagicDNS name unavailable" >&2; exit 1; }
[ -n "$TAILSCALE_OWNER" ] || { echo "error: Tailscale owner login unavailable" >&2; exit 1; }
export DSH_TRUSTED_HOSTS="${magicdns}${DSH_TRUSTED_HOSTS:+ ${DSH_TRUSTED_HOSTS}}"

/usr/bin/docker compose -f docker/docker-compose.yml build --no-cache
/usr/bin/docker compose -f docker/docker-compose.yml up -d --force-recreate "$@"
proxy="http://127.0.0.1:${DSH_PUBLIC_PORT}"
proxy_ready=
for _ in {1..10}; do
  if curl -fsS -o /dev/null "$proxy/" 2>/dev/null; then proxy_ready=1; break; fi
  sleep 1
done
[ -n "$proxy_ready" ] || { echo "error: proxy did not start at $proxy" >&2; exit 1; }
probe=( -sS -o /dev/null -w '%{http_code}' -X POST "$proxy/api/settings.describe" -H "Host: $magicdns" -H "Origin: https://$magicdns" -H 'content-type: application/json' --data '{}' )
denied="$(curl "${probe[@]}" -H 'Tailscale-User-Login: unauthorized@example.invalid')"
allowed="$(curl "${probe[@]}" -H "Tailscale-User-Login: $TAILSCALE_OWNER")"
[ "$denied" = 403 ] && [ "$allowed" = 200 ] || { echo "error: Tailscale identity proxy self-check failed" >&2; exit 1; }

tailscale serve --tcp=80 off >/dev/null 2>&1 || true
tailscale serve --yes --bg --https=443 "$proxy"

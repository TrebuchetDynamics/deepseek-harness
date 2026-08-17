#!/usr/bin/env bash
# Start the DeepSeek Harness web GUI and expose it to the tailnet.
#
# Serves through the tailnet IP over HTTP and its MagicDNS name over HTTPS,
# plus locally at http://127.0.0.1:4080/.
#
# dsh web binds 127.0.0.1 by design (the app refuses --host 0.0.0.0 for
# safety), so tailscale serve proxies the node's tailnet interface (port 80)
# to the local server.
#
# Extra args are forwarded to the web app (e.g. --trusted-host).
set -euo pipefail
cd "$(dirname "$0")"

PORT=4080
SERVE_PORT=80
HTTPS_PORT=443

# Tailnet identity for the served URLs (empty when tailscale is unavailable).
tailnet_ip="$(tailscale ip -4 2>/dev/null | head -n1 || true)"
magicdns="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.Self?.DNSName??"").replace(/\.$/,""))}catch{}})' || true)"

trusted_hosts=()
[ -n "$tailnet_ip" ] && trusted_hosts+=("$tailnet_ip")
[ -n "$magicdns" ] && trusted_hosts+=("$magicdns")

is_up() {
  curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null
}

is_tailnet_trusted() {
  local authority status
  for authority in "${trusted_hosts[@]}"; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' -H "Host: ${authority}" \
      "http://127.0.0.1:${PORT}/api/__tailnet_probe__" 2>/dev/null)"
    [ "$status" != 403 ] || return 1
  done
}

if is_up; then
  if ! is_tailnet_trusted; then
    echo "error: the dsh web process on port ${PORT} does not trust this tailnet address; stop it and rerun this script" >&2
    exit 1
  fi
  echo "dsh web already running on http://127.0.0.1:${PORT}/ - reusing it."
  web_pid=""
else
  echo "Starting dsh web on http://127.0.0.1:${PORT}/ ..."
  web_args=(--port "${PORT}" "$@")
  [ "${#trusted_hosts[@]}" -eq 0 ] || web_args+=(--trusted-host "${trusted_hosts[@]}")
  pnpm dsh web "${web_args[@]}" &
  web_pid=$!
  for _ in $(seq 1 30); do
    is_up && break
    sleep 1
  done
  is_up || { echo "error: dsh web did not come up on port ${PORT} in time" >&2; kill "$web_pid" 2>/dev/null || true; exit 1; }
fi

# Raw TCP forwarding serves the tailnet IP; HTTPS gives browsers the canonical
# secure MagicDNS origin. HTTP proxy mode is cleared because it masks the IP
# route with 404 responses.
serve_tailnet() {
  tailscale serve --http="${SERVE_PORT}" off >/dev/null 2>&1 || true
  tailscale serve --yes --bg --tcp="${SERVE_PORT}" "tcp://127.0.0.1:${PORT}"
  tailscale serve --yes --bg --https="${HTTPS_PORT}" "http://127.0.0.1:${PORT}"
}

# Without the tailscale operator role, the CLI needs root; grant it once via
# sudo (prompts for your password) so subsequent runs need no sudo.
if ! serve_tailnet 2>/dev/null; then
  echo "tailscale serve needs the operator role; requesting it via sudo (one-time)..."
  sudo tailscale set --operator="$USER"
  serve_tailnet
fi

echo
echo "dsh web is live on your tailnet:"
[ -n "$magicdns" ] && echo "  https://${magicdns}/"
[ -n "$tailnet_ip" ] && echo "  http://${tailnet_ip}/"
echo "  (local: http://127.0.0.1:${PORT}/)"
echo
echo "Remove the tailnet exposure with:"
echo "  tailscale serve --https=${HTTPS_PORT} off"
echo "  tailscale serve --tcp=${SERVE_PORT} off"

if [ -n "$web_pid" ]; then
  trap 'kill "$web_pid" 2>/dev/null || true' INT TERM EXIT
  wait "$web_pid"
else
  # Reusing an existing instance: keep the script attached until Ctrl+C.
  while :; do sleep 3600; done
fi

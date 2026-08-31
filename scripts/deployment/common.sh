#!/usr/bin/env bash
# Shared host-deployment validation and Tailscale proxy policy.

# Print a fatal deployment diagnostic without exiting the caller's shell.
dsh_die() { echo "error: $*" >&2; return 1; }

# Print one deployment progress step.
dsh_info() { echo "==> $*"; }

# Print a non-fatal deployment diagnostic.
dsh_warn() { echo "warning: $*" >&2; }

# Keep successful command output concise, show elapsed progress, and replay failures.
dsh_run_step() {
  local description="$1" log="" status=0 started=$SECONDS command_pid="" tick=0 frames='|/-\' monitor_enabled=0
  local old_int old_term old_hup
  shift
  if [ "${DSH_VERBOSE:-0}" = 1 ]; then
    dsh_info "$description"
  else
    log="$(mktemp)" || return 1
  fi
  old_int="$(trap -p INT)"
  old_term="$(trap -p TERM)"
  old_hup="$(trap -p HUP)"
  trap 'trap - INT TERM HUP; kill -- "-$command_pid" 2>/dev/null || true; wait "$command_pid" 2>/dev/null || true; rm -f "$log"; exit 130' INT
  trap 'trap - INT TERM HUP; kill -- "-$command_pid" 2>/dev/null || true; wait "$command_pid" 2>/dev/null || true; rm -f "$log"; exit 143' TERM
  trap 'trap - INT TERM HUP; kill -- "-$command_pid" 2>/dev/null || true; wait "$command_pid" 2>/dev/null || true; rm -f "$log"; exit 129' HUP
  case $- in *m*) monitor_enabled=1 ;; *) set -m ;; esac
  if [ "${DSH_VERBOSE:-0}" = 1 ]; then
    "$@" &
  else
    "$@" >"$log" 2>&1 &
  fi
  command_pid=$!
  [ "$monitor_enabled" = 1 ] || set +m
  if [ "${DSH_VERBOSE:-0}" != 1 ]; then
    if [ -t 1 ]; then
      while kill -0 "$command_pid" 2>/dev/null; do
        printf '\r\033[2K==> %s [%s %ss]' "$description" "${frames:tick%4:1}" "$((SECONDS - started))"
        tick=$((tick + 1))
        sleep 0.2
      done
      printf '\r\033[2K'
    else
      dsh_info "$description"
    fi
  fi
  wait "$command_pid" || status=$?
  command_pid=""
  [ -z "$old_int" ] && trap - INT || eval "$old_int"
  [ -z "$old_term" ] && trap - TERM || eval "$old_term"
  [ -z "$old_hup" ] && trap - HUP || eval "$old_hup"
  if [ "${DSH_VERBOSE:-0}" = 1 ]; then
    return "$status"
  fi
  if [ "$status" -eq 0 ]; then
    dsh_info "$description done ($((SECONDS - started))s)"
  else
    dsh_info "$description failed ($((SECONDS - started))s)"
    cat "$log" >&2
  fi
  rm -f "$log"
  return "$status"
}

# Run the Node binary resolved from the service user's login shell.
dsh_node() { "${DSH_NODE_BIN:-node}" "$@"; }

# Validate a TCP port used by a deployment launcher.
dsh_validate_port() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] && (( 10#$value >= 1 && 10#$value <= 65535 )) || {
    dsh_die "$name must be an integer from 1 to 65535"
    return 1
  }
}

# Serialize Docker and native mutations of one user's deployment.
dsh_acquire_deployment_lock() {
  local home="$1" lock_dir="$1/.dsh"
  mkdir -p "$lock_dir"
  exec 9>"$lock_dir/deployment.lock"
  flock 9
}

# Reject a profile that loads the sidebar directly and through the aggregate UI.
dsh_reject_duplicate_sidebar() {
  local home="$1" profile_manifest="$1/.dsh/profiles/web/package.json"
  [ -f "$profile_manifest" ] || return 0
  dsh_node - "$profile_manifest" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const manifestPath = process.argv[2]
const profileDir = path.dirname(manifestPath)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const bundles = manifest.dsh?.profile?.bundles
const aggregate = '@linxin666/dsh-web-ui-all'
const sidebar = 'dsh-better-sidebar'
if (!Array.isArray(bundles) || !bundles.includes(aggregate) || !bundles.includes(sidebar)) process.exit(0)
const aggregatePath = path.join(profileDir, 'node_modules', aggregate, 'package.json')
if (!fs.existsSync(aggregatePath)) process.exit(0)
const aggregateManifest = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'))
if (typeof aggregateManifest.dependencies?.[sidebar] !== 'string') process.exit(0)
console.error(`profile web loads ${sidebar} from multiple bundles: ${aggregate}, ${sidebar}`)
console.error(`remove the redundant direct bundle: pnpm dsh plugin --profile web remove ${sidebar}`)
process.exit(2)
NODE
}

# Install, build, and verify the source checkout consumed by a deployment.
dsh_prepare_checkout() {
  local repo="$1" pnpm_bin="$2" missing verifier
  verifier="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)/verify-deployment-artifacts.mjs"
  dsh_run_step "Installing checkout dependencies" "$pnpm_bin" --dir "$repo" install --frozen-lockfile || {
    dsh_die "checkout dependency installation failed: $repo"
    return 1
  }
  dsh_run_step "Building checkout artifacts" "$pnpm_bin" --dir "$repo" run build || {
    dsh_die "checkout build failed: $repo"
    return 1
  }
  missing="$(dsh_node "$verifier" "$repo")" || return 1
  [ -z "$missing" ] || dsh_die "checkout build omitted required artifacts: $missing"
}

# Resolve the connected host node's MagicDNS name, IPv4 address, and owner login.
dsh_load_tailscale_identity() {
  local status parsed backend_state detected_owner
  status="$(tailscale status --json 2>/dev/null)" || {
    dsh_die "Tailscale status unavailable; connect this host with 'tailscale up'"
    return 1
  }
  parsed="$(printf '%s' "$status" | dsh_node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const j = JSON.parse(s)
  const self = j.Self ?? {}
  const dns = String(self.DNSName ?? "").replace(/\.$/, "")
  const state = String(j.BackendState ?? "Running")
  const owner = String(j.User?.[self.UserID]?.LoginName ?? "")
  process.stdout.write([dns, state, owner].join("\t"))
})')" || { dsh_die "Tailscale returned invalid status JSON"; return 1; }
  IFS=$'\t' read -r DSH_MAGICDNS backend_state detected_owner <<<"$parsed"
  [ "$backend_state" = Running ] || { dsh_die "Tailscale is not connected"; return 1; }
  [ -n "$DSH_MAGICDNS" ] || { dsh_die "Tailscale MagicDNS name unavailable"; return 1; }
  [ -n "$detected_owner" ] || { dsh_die "Tailscale owner login unavailable"; return 1; }
  DSH_TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n1)"
  [ -n "$DSH_TAILSCALE_IP" ] || { dsh_die "Tailscale IPv4 address unavailable"; return 1; }
  DSH_TAILSCALE_LOGIN="$detected_owner"
  TAILSCALE_OWNER="${TAILSCALE_OWNER:-$detected_owner}"
  export DSH_MAGICDNS DSH_TAILSCALE_IP DSH_TAILSCALE_LOGIN TAILSCALE_OWNER
}

# Prove that the proxy denies an unowned identity and admits its configured owner.
dsh_probe_identity_proxy() {
  local proxy="$1" magicdns="$2" owner="$3" launch_url="$4" deadline="${5:-$SECONDS}"
  local token cookie_jar exchange namespace_denied namespace_allowed denied allowed
  token="${launch_url#*\?token=}"
  [[ "$launch_url" =~ ^http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+$ && "$token" =~ ^[A-Za-z0-9_-]+$ ]] || {
    dsh_die "Harness backend did not publish a valid launch URL"
    return 1
  }
  cookie_jar="$(mktemp)" || return 1
  chmod 0600 "$cookie_jar"
  exchange="$(curl -sS --max-time 5 -c "$cookie_jar" -o /dev/null -w '%{http_code}' \
    "$proxy/?token=$token" -H "Host: $magicdns")" || {
    rm -f "$cookie_jar"
    dsh_die "browser launch-token exchange through the identity proxy failed"
    return 1
  }
  if [ "$exchange" != 303 ]; then
    rm -f "$cookie_jar"
    dsh_die "browser launch-token exchange through the identity proxy returned $exchange"
    return 1
  fi
  local namespace_probe=(
    -sS --max-time 5 -b "$cookie_jar" -o /dev/null -w '%{http_code}' -X POST
    "$proxy/api/__dsh_api_namespace_probe__"
    -H "Host: $magicdns"
    -H "Origin: https://$magicdns"
    -H 'content-type: application/json'
    --data '{}'
  )
  namespace_denied="$(curl "${namespace_probe[@]}" -H 'Tailscale-User-Login: unauthorized@example.invalid')" || {
    rm -f "$cookie_jar"
    dsh_die "Tailscale API namespace self-check request failed for the unauthorized identity"
    return 1
  }
  namespace_allowed="$(curl "${namespace_probe[@]}" -H "Tailscale-User-Login: $owner")" || {
    rm -f "$cookie_jar"
    dsh_die "Tailscale API namespace self-check request failed for $owner"
    return 1
  }
  if [ "$namespace_denied" != 403 ] || [ "$namespace_allowed" != 404 ]; then
    rm -f "$cookie_jar"
    dsh_die "Tailscale API namespace self-check failed (denied=$namespace_denied allowed=$namespace_allowed)"
    return 1
  fi
  local probe=(
    -sS --max-time 5 -b "$cookie_jar" -o /dev/null -w '%{http_code}' -X POST
    "$proxy/api/settings/describe"
    -H "Host: $magicdns"
    -H "Origin: https://$magicdns"
    -H 'content-type: application/json'
    --data '{"type":"client-request","rpcId":"deployment-probe","method":"settings/describe","payload":{"args":{}}}'
  )
  while :; do
    denied="$(curl "${probe[@]}" -H 'Tailscale-User-Login: unauthorized@example.invalid')" || {
      rm -f "$cookie_jar"
      dsh_die "Tailscale identity proxy self-check request failed for the unauthorized identity"
      return 1
    }
    allowed="$(curl "${probe[@]}" -H "Tailscale-User-Login: $owner")" || {
      rm -f "$cookie_jar"
      dsh_die "Tailscale identity proxy self-check request failed for $owner"
      return 1
    }
    if [ "$denied" = 403 ] && [ "$allowed" = 200 ]; then
      rm -f "$cookie_jar"
      return 0
    fi
    [ "$denied" = 403 ] && [ "$allowed" = 404 ] && (( SECONDS < deadline )) || break
    sleep 1
  done
  rm -f "$cookie_jar"
  dsh_die "Tailscale identity proxy self-check failed (denied=$denied allowed=$allowed)"
  return 1
}

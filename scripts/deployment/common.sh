#!/usr/bin/env bash
# Shared host-deployment validation and Tailscale proxy policy.

# Print a fatal deployment diagnostic without exiting the caller's shell.
dsh_die() { echo "error: $*" >&2; return 1; }

# Print one deployment progress step.
dsh_info() { echo "==> $*"; }

# Print a non-fatal deployment diagnostic.
dsh_warn() { echo "warning: $*" >&2; }

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
  "$pnpm_bin" --dir "$repo" install --frozen-lockfile || {
    dsh_die "checkout dependency installation failed: $repo"
    return 1
  }
  "$pnpm_bin" --dir "$repo" run build || {
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
  local proxy="$1" magicdns="$2" owner="$3" denied allowed
  local probe=(
    -sS --max-time 5 -o /dev/null -w '%{http_code}' -X POST
    "$proxy/api/settings.describe"
    -H "Host: $magicdns"
    -H "Origin: https://$magicdns"
    -H 'content-type: application/json'
    --data '{}'
  )
  denied="$(curl "${probe[@]}" -H 'Tailscale-User-Login: unauthorized@example.invalid')" || {
    dsh_die "Tailscale identity proxy self-check request failed for the unauthorized identity"
    return 1
  }
  allowed="$(curl "${probe[@]}" -H "Tailscale-User-Login: $owner")" || {
    dsh_die "Tailscale identity proxy self-check request failed for $owner"
    return 1
  }
  [ "$denied" = 403 ] && [ "$allowed" = 200 ] || {
    dsh_die "Tailscale identity proxy self-check failed (denied=$denied allowed=$allowed)"
    return 1
  }
}

#!/usr/bin/env bash
# Host-native service rendering, supervision, lifecycle, and migration helpers.

DSH_SERVICE_NAME=deepseek-harness.service
DSH_PNPM_VERSION=11.7.0
DSH_SERVICE_RUNTIME_DIR="${DSH_SERVICE_RUNTIME_DIR:-/run/deepseek-harness}"
DSH_SYSTEM_ROOT="${DSH_SYSTEM_ROOT:-}"
DSH_UNIT_FILE="$DSH_SYSTEM_ROOT/etc/systemd/system/$DSH_SERVICE_NAME"
DSH_CONFIG_FILE="$DSH_SYSTEM_ROOT/etc/deepseek-harness.env"
DSH_STATE_DIR="$DSH_SYSTEM_ROOT/var/lib/deepseek-harness"
DSH_STATE_FILE="$DSH_STATE_DIR/deployment.json"
DSH_CADDY_INSTALL_MARKER="$DSH_STATE_DIR/caddy-package-installing"
DSH_INSTALL_RUNTIME_DIR="$DSH_SYSTEM_ROOT/run/deepseek-harness-install"
DSH_LIBEXEC_DIR="$DSH_SYSTEM_ROOT/usr/local/libexec/deepseek-harness"
DSH_INSTALLED_START="$DSH_LIBEXEC_DIR/start.sh"

native_validate_systemd_value() {
  local name="$1" value="$2"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    dsh_die "$name must not contain line breaks"
    return 1
  }
}

native_systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

# Escape a path for systemd directives that treat quotes as literal bytes.
native_systemd_path() {
  local value="$1"
  value="${value//\\/\\x5c}"
  value="${value//%/%%}"
  value="${value//$'\t'/\\x09}"
  value="${value// /\\x20}"
  value="${value//\"/\\x22}"
  printf '%s' "$value"
}

native_render_unit() {
  local user="$1" group="$2" home="$3" repo="$4" login_shell="$5" start_path="$6" config_path="$7" provider="${8:-tailscale}"
  local value wants="network-online.target" after="network-online.target" requires="" part_of=""
  [ "$provider" = tailscale ] || [ "$provider" = netbird ] || {
    dsh_die "unsupported VPN provider: $provider"
    return 1
  }
  if [ "$provider" = tailscale ]; then
    after="network-online.target tailscaled.service"
    requires="Requires=tailscaled.service"
    part_of="PartOf=tailscaled.service"
  fi
  for value in "$user" "$group" "$home" "$repo" "$login_shell" "$start_path" "$config_path"; do
    native_validate_systemd_value "systemd unit value" "$value" || return 1
  done
  cat <<EOF
[Unit]
Description=DeepSeek Harness
Wants=$wants
After=$after
$requires
$part_of
StartLimitIntervalSec=0

[Service]
Type=notify
NotifyAccess=all
User=$user
Group=$group
WorkingDirectory=$(native_systemd_path "$repo")
Environment=$(native_systemd_quote "HOME=$home")
Environment=$(native_systemd_quote "USER=$user")
Environment=$(native_systemd_quote "DSH_HOME=$home/.dsh")
Environment=$(native_systemd_quote "DSH_NODE_BIN=${DSH_NODE_BIN:-node}")
Environment=$(native_systemd_quote "DSH_PNPM_BIN=${DSH_PNPM_BIN:-pnpm}")
Environment=$(native_systemd_quote "DSH_RUNTIME_ROOT=$DSH_LIBEXEC_DIR")
EnvironmentFile=$(native_systemd_path "$config_path")
RuntimeDirectory=deepseek-harness
RuntimeDirectoryMode=0700
ExecStart=$(native_systemd_quote "$start_path") __service $(native_systemd_quote "$config_path") $(native_systemd_quote "$repo") $(native_systemd_quote "$user") $(native_systemd_quote "$home") $(native_systemd_quote "$login_shell")
Restart=always
RestartSec=10s
TimeoutStartSec=65min
TimeoutStopSec=30s
KillMode=mixed
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
}

native_login_exec() {
  local user="$1" home="$2" login_shell="$3" command="$4"
  runuser -u "$user" -- env \
    HOME="$home" \
    USER="$user" \
    PATH="${DSH_CALLER_PATH:-$PATH}" \
    "$login_shell" -lc "$command"
}

native_validate_login_shell() {
  local user="$1" home="$2" login_shell="$3"
  native_login_exec "$user" "$home" "$login_shell" ':' >/dev/null 2>&1 || {
    dsh_die "$login_shell login shell cannot run non-interactive commands for $user"
    return 1
  }
}

native_distribution() {
  local os_release=/etc/os-release distribution line
  if [ -n "$DSH_SYSTEM_ROOT" ] && [ -f "$DSH_SYSTEM_ROOT/etc/os-release" ]; then
    os_release="$DSH_SYSTEM_ROOT/etc/os-release"
  fi
  while IFS= read -r line; do
    case "$line" in
      ID=*)
        distribution="${line#ID=}"
        distribution="${distribution#\"}"
        distribution="${distribution%\"}"
        distribution="${distribution#\'}"
        distribution="${distribution%\'}"
        printf '%s' "$distribution"
        return
        ;;
    esac
  done <"$os_release"
}

native_dependency_guidance() {
  local provider="$1"; shift
  local missing="$*" distribution command guidance vpn_package="$provider"
  distribution="$(native_distribution)"
  case "$distribution" in
    ubuntu)
      command="sudo apt install caddy $vpn_package iproute2 git curl util-linux coreutils"
      guidance="Configure the official Caddy and $vpn_package APT repositories first."
      ;;
    fedora)
      command="sudo dnf install caddy $vpn_package iproute git curl util-linux coreutils"
      guidance="Configure the official Caddy and $vpn_package RPM repositories first when these packages are unavailable."
      ;;
    arch)
      command="sudo pacman -S caddy $vpn_package iproute2 git curl util-linux coreutils"
      guidance="Use the official Arch repositories and follow the $vpn_package package documentation."
      ;;
    *)
      printf 'error: unsupported Linux distribution %s; install manually: %s\n' "${distribution:-unknown}" "$missing" >&2
      printf 'Required versions: Node.js ^22.19.0 or >=24.0.0; pnpm %s.\n' "$DSH_PNPM_VERSION" >&2
      return 1
      ;;
  esac
  printf 'error: missing host dependencies for the service user: %s\n' "$missing" >&2
  printf '%s\n' "$guidance" "Suggested command (not executed): $command" >&2
  printf 'Required versions: Node.js ^22.19.0 or >=24.0.0; pnpm %s.\n' "$DSH_PNPM_VERSION" >&2
  return 1
}

native_require_root_tools() {
  local tool
  local -a missing=()
  for tool in systemctl systemd-analyze runuser getent install flock readlink stat; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  [ "${#missing[@]}" -eq 0 ] || {
    dsh_die "missing root-side host dependencies: ${missing[*]}"
    return 1
  }
}

native_collect_missing_user_tools() {
  local user="$1" home="$2" login_shell="$3" provider="$4" tool
  local -n result="$5"
  local vpn_tool=tailscale
  [ "$provider" = netbird ] && vpn_tool=netbird
  for tool in node pnpm git curl caddy "$vpn_tool" setsid ss systemd-notify; do
    native_login_exec "$user" "$home" "$login_shell" "command -v '$tool' >/dev/null" || result+=("$tool")
  done
}

native_enable_missing_pnpm() {
  local user="$1" home="$2" login_shell="$3"
  native_login_exec "$user" "$home" "$login_shell" 'command -v pnpm >/dev/null' && return 0
  native_login_exec "$user" "$home" "$login_shell" 'command -v corepack >/dev/null' || return 0
  dsh_info "Activating pnpm $DSH_PNPM_VERSION through Corepack for $user"
  native_login_exec "$user" "$home" "$login_shell" \
    "corepack prepare 'pnpm@$DSH_PNPM_VERSION' --activate && corepack enable pnpm" || {
    dsh_die "could not activate pnpm $DSH_PNPM_VERSION through Corepack"
    return 1
  }
}

native_reconcile_caddy_package_service() {
  local enablement
  [ -e "$DSH_CADDY_INSTALL_MARKER" ] || return 0
  dsh_info "Recovering an interrupted Caddy package installation"
  systemctl unmask caddy.service >/dev/null 2>&1 || {
    dsh_die "could not remove the Caddy package service safety mask"
    return 1
  }
  if systemctl cat caddy.service >/dev/null 2>&1; then
    if ! systemctl disable --now caddy.service >/dev/null 2>&1; then
      systemctl mask caddy.service >/dev/null 2>&1 || true
      dsh_die "could not disable the package Caddy service; its safety mask was restored"
      return 1
    fi
    enablement="$(systemctl is-enabled caddy.service 2>/dev/null || true)"
    case "$enablement" in
      enabled | enabled-runtime | linked | linked-runtime | alias)
        systemctl mask caddy.service >/dev/null 2>&1 || true
        dsh_die "the package Caddy service remained $enablement after disable; its safety mask was restored"
        return 1
        ;;
    esac
  fi
  rm -f "$DSH_CADDY_INSTALL_MARKER"
}

native_install_missing_host_packages() {
  local distribution tool caddy_missing=0 install_status=0 cleanup_status=0
  for tool in "$@"; do
    [ "$tool" != caddy ] || caddy_missing=1
  done
  [ "$caddy_missing" = 1 ] || return 0
  distribution="$(native_distribution)"
  case "$distribution" in ubuntu | fedora) ;; *) return 0 ;; esac
  systemctl cat caddy.service >/dev/null 2>&1 && {
    dsh_die "caddy.service already exists but Caddy is absent from the service user's login shell; refusing to replace an existing host service"
    return 1
  }
  install -d -o root -g root -m 0755 "$DSH_STATE_DIR" || return 1
  install -o root -g root -m 0600 /dev/null "$DSH_CADDY_INSTALL_MARKER" || return 1
  systemctl mask caddy.service >/dev/null || {
    rm -f "$DSH_CADDY_INSTALL_MARKER"
    dsh_die "could not prevent the Caddy package service from starting during installation"
    return 1
  }
  case "$distribution" in
    ubuntu)
      dsh_run_step "Refreshing Ubuntu package metadata" apt-get update || install_status=$?
      if [ "$install_status" = 0 ]; then
        dsh_run_step "Installing the Caddy package" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends caddy || install_status=$?
      fi
      ;;
    fedora) dsh_run_step "Installing the Caddy package" dnf install -y caddy || install_status=$? ;;
  esac
  native_reconcile_caddy_package_service || cleanup_status=$?
  [ "$install_status" = 0 ] || {
    dsh_die "$distribution could not install Caddy; configure its official repository, then retry"
    return 1
  }
  [ "$cleanup_status" = 0 ] || {
    dsh_die "installed Caddy but could not disable and unmask its package service safely"
    return 1
  }
  command -v caddy >/dev/null 2>&1 || {
    dsh_die "the Caddy package installed without a root-visible binary"
    return 1
  }
}

native_require_user_tools() {
  local user="$1" home="$2" login_shell="$3" provider="$4" node_version pnpm_version
  local -a missing=()
  native_reconcile_caddy_package_service || return 1
  native_enable_missing_pnpm "$user" "$home" "$login_shell" || return 1
  native_collect_missing_user_tools "$user" "$home" "$login_shell" "$provider" missing
  if [ "${#missing[@]}" -gt 0 ]; then
    native_install_missing_host_packages "${missing[@]}" || return 1
    missing=()
    native_collect_missing_user_tools "$user" "$home" "$login_shell" "$provider" missing
  fi
  [ "${#missing[@]}" -eq 0 ] || {
    native_dependency_guidance "$provider" "${missing[@]}"
    return 1
  }
  DSH_NODE_BIN="$(native_login_exec "$user" "$home" "$login_shell" 'command -v node')" || return 1
  [ -x "$DSH_NODE_BIN" ] || {
    dsh_die "resolved Node.js path is not executable: $DSH_NODE_BIN"
    return 1
  }
  DSH_PNPM_BIN="$(native_login_exec "$user" "$home" "$login_shell" 'command -v pnpm')" || return 1
  [ -x "$DSH_PNPM_BIN" ] || {
    dsh_die "resolved pnpm path is not executable: $DSH_PNPM_BIN"
    return 1
  }
  export DSH_NODE_BIN DSH_PNPM_BIN
  node_version="$("$DSH_NODE_BIN" -p "process.versions.node")" || return 1
  dsh_node -e '
const [major, minor] = process.argv[1].split(".").map(Number)
process.exit((major === 22 && minor >= 19) || major >= 24 ? 0 : 1)
' "$node_version" || {
    dsh_die "Node.js $node_version is unsupported; install ^22.19.0 or >=24.0.0"
    return 1
  }
  pnpm_version="$(PATH="${DSH_NODE_BIN%/*}:$PATH" "$DSH_PNPM_BIN" --version)" || return 1
  [ "$pnpm_version" = "$DSH_PNPM_VERSION" ] || {
    dsh_die "pnpm $pnpm_version is unsupported; install pnpm $DSH_PNPM_VERSION"
    return 1
  }
  native_login_exec "$user" "$home" "$login_shell" 'caddy version' | grep -Eq '^v?2\.' || {
    dsh_die "Caddy 2 is required through the service login shell"
    return 1
  }
}

native_prepare_checkout_as_user() {
  local user="$1" home="$2" login_shell="$3" repo="$4" common_script
  common_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/common.sh"
  runuser -u "$user" -- env \
    HOME="$home" \
    USER="$user" \
    PATH="${DSH_CALLER_PATH:-$PATH}" \
    DSH_DEPLOY_COMMON="$common_script" \
    DSH_DEPLOY_REPO="$repo" \
    "$login_shell" -lc 'source "$DSH_DEPLOY_COMMON"; dsh_prepare_checkout "$DSH_DEPLOY_REPO" "$(command -v pnpm)"'
}

native_check_operator() {
  local user="$1" prefs operator
  prefs="$(tailscale debug prefs 2>/dev/null)" || {
    dsh_die "cannot inspect the current Tailscale operator"
    return 1
  }
  operator="$(printf '%s' "$prefs" | dsh_node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const j = JSON.parse(s)
  process.stdout.write(String(j.OperatorUser ?? ""))
})')" || { dsh_die "Tailscale returned invalid preference JSON"; return 1; }
  [ -z "$operator" ] || [ "$operator" = "$user" ] || {
    dsh_die "Tailscale operator is already $operator; refusing to replace it with $user"
    return 1
  }
  [ -n "$operator" ] || tailscale set --operator="$user"
}

native_install_file_atomically() {
  local source="$1" target="$2" mode="$3" stage
  stage="$(mktemp "${target}.tmp.XXXXXX")" || return 1
  if ! install -o root -g root -m "$mode" "$source" "$stage"; then
    rm -f "$stage"
    return 1
  fi
  if ! mv -Tf "$stage" "$target"; then
    rm -f "$stage"
    return 1
  fi
}

# Install the root-owned control plane outside home for systemd and SELinux.
native_install_runtime_assets() {
  local repo="$1" asset source target mode
  local -a assets=(
    "start.sh:start.sh:0755"
    "scripts/deployment/common.sh:scripts/deployment/common.sh:0644"
    "scripts/deployment/native-service.sh:scripts/deployment/native-service.sh:0644"
    "scripts/verify-deployment-artifacts.mjs:scripts/verify-deployment-artifacts.mjs:0644"
    "deployment/Caddyfile:deployment/Caddyfile:0644"
  )
  install -d -o root -g root -m 0755 \
    "$DSH_LIBEXEC_DIR" "$DSH_LIBEXEC_DIR/scripts/deployment" "$DSH_LIBEXEC_DIR/deployment" || return 1
  for asset in "${assets[@]}"; do
    IFS=: read -r source target mode <<<"$asset"
    native_install_file_atomically "$repo/$source" "$DSH_LIBEXEC_DIR/$target" "$mode" || return 1
  done
  command -v restorecon >/dev/null 2>&1 && restorecon -RF "$DSH_LIBEXEC_DIR" || true
}

native_write_default_config() {
  local path="$1" provider="$2" owner="$3" tmp existing
  if [ -e "$path" ]; then
    native_validate_config "$path" || return 1
    existing="$(sed -n 's/^DSH_VPN_PROVIDER=//p' "$path")"
    if [ -z "$existing" ]; then
      printf 'DSH_VPN_PROVIDER=%s\n' "$provider" >>"$path"
    elif [ "$existing" != "$provider" ]; then
      dsh_die "configured DSH_VPN_PROVIDER $existing differs from requested $provider; edit $path before reinstalling"
      return 1
    fi
    native_validate_config "$path"
    return
  fi
  tmp="$(mktemp)"
  cat >"$tmp" <<EOF
DSH_BACKEND_PORT=4081
DSH_PUBLIC_PORT=4080
DSH_HTTPS_PORT=443
DSH_STARTUP_TIMEOUT=90
DSH_VPN_PROVIDER=$provider
EOF
  if [ "$provider" = tailscale ]; then
    printf 'TAILSCALE_OWNER=%s\n' "$owner" >>"$tmp"
  fi
  printf 'DSH_EXTRA_TRUSTED_HOSTS=\n' >>"$tmp"
  if ! native_install_file_atomically "$tmp" "$path" 0644; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
}

native_redact() {
  local text="$1" token="${DSH_TASK_BOARD_PROXY_TOKEN:-}"
  [ -z "$token" ] || text="${text//$token/[redacted]}"
  printf '%s\n' "$text"
}

native_start_and_verify() {
  local output
  dsh_info "Starting and enabling $DSH_SERVICE_NAME; waiting for readiness"
  if ! output="$(systemctl enable --now "$DSH_SERVICE_NAME" 2>&1)"; then
    [ -z "$output" ] || native_redact "$output" >&2
    output="$(systemctl status --no-pager --full "$DSH_SERVICE_NAME" 2>&1 || true)"
    [ -z "$output" ] || native_redact "$output" >&2
    output="$(journalctl -u "$DSH_SERVICE_NAME" -n 50 --no-pager 2>&1 || true)"
    [ -z "$output" ] || native_redact "$output" >&2
    return 1
  fi
  systemctl is-active --quiet "$DSH_SERVICE_NAME" || {
    dsh_die "$DSH_SERVICE_NAME did not remain active"
    return 1
  }
  dsh_info "$DSH_SERVICE_NAME is active"
}

native_current_serve_target() {
  tailscale serve status --json 2>/dev/null | dsh_node -e '
let s = ""
process.stdin.on("data", d => { s += d }).on("end", () => {
  const status = JSON.parse(s)
  const port = process.argv[1]
  const proxies = []
  const visit = (value) => {
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value)) {
      if (key === "Proxy" && typeof child === "string") proxies.push(child)
      else visit(child)
    }
  }
  for (const [authority, value] of Object.entries(status.Web ?? {})) {
    if (authority.endsWith(`:${port}`)) visit(value)
  }
  if (proxies.length > 1) process.exitCode = 2
  else process.stdout.write(proxies[0] ?? "")
})' "$DSH_HTTPS_PORT"
}

native_assert_expected_serve_target() {
  local expected="$1" actual
  actual="$(native_current_serve_target)" || {
    dsh_die "cannot prove a single active Tailscale Serve target on HTTPS port $DSH_HTTPS_PORT"
    return 1
  }
  [ "$actual" = "$expected" ] || {
    dsh_die "Tailscale Serve target is ${actual:-unowned}, expected $expected"
    return 1
  }
}

native_check_route_ownership() {
  local expected="$1" actual
  actual="$(native_current_serve_target)" || {
    dsh_die "cannot prove a single active Tailscale Serve target on HTTPS port $DSH_HTTPS_PORT"
    return 1
  }
  [ -z "$actual" ] || [ "$actual" = "$expected" ] || {
    dsh_die "Tailscale Serve HTTPS port $DSH_HTTPS_PORT is already owned by $actual"
    return 1
  }
}

native_load_owned_state() {
  local expected_repo="$1" recover_missing_checkout="${2:-0}" recorded_checkout state_output
  local -a state=()
  native_validate_external_file "$DSH_STATE_FILE" "deployment state" || return 1
  state_output="$(dsh_node -e '
const fs = require("node:fs")
const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const keys = Object.keys(state).sort().join(",")
if (keys !== "checkout,httpsPort,publicTarget,serviceUser") process.exit(2)
if (typeof state.checkout !== "string" || typeof state.serviceUser !== "string") process.exit(2)
if (!Number.isInteger(state.httpsPort) || state.httpsPort < 1 || state.httpsPort > 65535) process.exit(2)
const target = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(state.publicTarget)
if (!target || Number(target[1]) > 65535) process.exit(2)
for (const value of [state.checkout, state.serviceUser, String(state.httpsPort), state.publicTarget]) {
  if (/[\r\n]/.test(value)) process.exit(2)
  console.log(value)
}
' "$DSH_STATE_FILE")" || {
    dsh_die "deployment state is malformed: $DSH_STATE_FILE"
    return 1
  }
  mapfile -t state <<<"$state_output"
  [ "${#state[@]}" -eq 4 ] || { dsh_die "deployment state is incomplete: $DSH_STATE_FILE"; return 1; }
  recorded_checkout="${state[0]}"
  DSH_STATE_CHECKOUT_MISSING=0
  if [ ! -e "$recorded_checkout" ]; then
    [ "$recover_missing_checkout" = 1 ] || {
      dsh_die "installed service checkout no longer exists: $recorded_checkout; run './start.sh install' from the desired checkout to recover"
      return 1
    }
    DSH_STATE_CHECKOUT="$recorded_checkout"
    DSH_STATE_CHECKOUT_MISSING=1
    dsh_info "Recovering the installed service from missing checkout $recorded_checkout"
  elif ! DSH_STATE_CHECKOUT="$(readlink -f "$recorded_checkout")"; then
    dsh_die "cannot resolve installed service checkout: $recorded_checkout"
    return 1
  fi
  DSH_STATE_USER="${state[1]}"
  DSH_STATE_HTTPS_PORT="${state[2]}"
  DSH_STATE_TARGET="${state[3]}"
  [ "$DSH_STATE_CHECKOUT_MISSING" = 1 ] || [ "$DSH_STATE_CHECKOUT" = "$(readlink -f "$expected_repo")" ] || {
    dsh_die "installed service belongs to $DSH_STATE_CHECKOUT, not $expected_repo"
    return 1
  }
  native_validate_external_file "$DSH_UNIT_FILE" "systemd unit" || return 1
  grep -Fq "User=$DSH_STATE_USER" "$DSH_UNIT_FILE" &&
    grep -Fq "ExecStart=\"$DSH_INSTALLED_START\" __service" "$DSH_UNIT_FILE" || {
      dsh_die "$DSH_UNIT_FILE does not match the recorded native installation"
      return 1
    }
  export DSH_STATE_CHECKOUT DSH_STATE_CHECKOUT_MISSING DSH_STATE_USER DSH_STATE_HTTPS_PORT DSH_STATE_TARGET
}

native_validate_owned_route() {
  local actual provider="${DSH_VPN_PROVIDER:-tailscale}"
  if [ -f "$DSH_CONFIG_FILE" ]; then
    native_validate_config "$DSH_CONFIG_FILE" || return 1
    # shellcheck disable=SC1090 -- native_validate_config accepts only fixed keys.
    source "$DSH_CONFIG_FILE"
    provider="${DSH_VPN_PROVIDER:-tailscale}"
  fi
  DSH_HTTPS_PORT="$DSH_STATE_HTTPS_PORT"
  if [ "$provider" = netbird ]; then
    dsh_load_netbird_identity
    return
  fi
  actual="$(native_current_serve_target)" || {
    dsh_die "cannot prove a single active Tailscale Serve target on HTTPS port $DSH_STATE_HTTPS_PORT"
    return 1
  }
  [ -z "$actual" ] || [ "$actual" = "$DSH_STATE_TARGET" ] || {
    dsh_die "Tailscale Serve HTTPS port $DSH_STATE_HTTPS_PORT is owned by $actual, not this installation"
    return 1
  }
}

native_remove_owned_docker() {
  local repo="$1" expected_compose="$1/docker/docker-compose.yml" output id service working_dir canonical_working_dir config_files file
  local dsh_id="" proxy_id=""
  local -a ids=() files=()
  command -v docker >/dev/null 2>&1 || return 0
  output="$(docker ps -q --filter label=com.docker.compose.project)" || {
    dsh_warn "cannot inspect Docker; continuing with native port checks"
    return 0
  }
  mapfile -t ids <<<"$output"
  for id in "${ids[@]}"; do
    [ -n "$id" ] || continue
    service="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$id")" || return 1
    case "$service" in dsh | auth-proxy) ;; *) continue ;; esac
    working_dir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$id")" || return 1
    canonical_working_dir="$(readlink -f "$working_dir")" || continue
    [ "$canonical_working_dir" = "$repo" ] || [ "$canonical_working_dir" = "$repo/docker" ] || continue
    config_files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$id")" || return 1
    IFS=, read -ra files <<<"$config_files"
    local owns_compose=0
    for file in "${files[@]}"; do
      [ "$file" != "$expected_compose" ] || owns_compose=1
    done
    [ "$owns_compose" = 1 ] || continue
    case "$service" in
      dsh) [ -z "$dsh_id" ] || { dsh_die "multiple owned Docker dsh containers are running"; return 1; }; dsh_id="$id" ;;
      auth-proxy) [ -z "$proxy_id" ] || { dsh_die "multiple owned Docker auth-proxy containers are running"; return 1; }; proxy_id="$id" ;;
    esac
  done
  if [ -z "$dsh_id" ] && [ -z "$proxy_id" ]; then
    return 0
  fi
  [ -n "$dsh_id" ] && [ -n "$proxy_id" ] || {
    dsh_die "owned Docker Harness is incomplete; refusing automatic takeover"
    return 1
  }
  dsh_info "Removing the owned Docker deployment before native startup"
  docker rm -f "$dsh_id" "$proxy_id" >/dev/null || {
    dsh_die "could not remove the owned Docker deployment"
    return 1
  }
  DSH_DOCKER_REMOVED=1
}

native_assert_ports_available() {
  local listeners port
  listeners="$(ss -H -ltn)" || {
    dsh_die "cannot inspect listening TCP ports with ss"
    return 1
  }
  for port in "$DSH_BACKEND_PORT" "$DSH_PUBLIC_PORT"; do
    if printf '%s\n' "$listeners" | grep -Eq ":${port}[[:space:]]"; then
      dsh_die "loopback port $port is already owned by another listener"
      return 1
    fi
  done
}

native_start_service() {
  local repo="$1"
  native_remove_owned_docker "$repo" || return 1
  dsh_info "Checking native service ports"
  native_assert_ports_available || return 1
  native_start_and_verify
}

native_write_state() {
  local repo="$1" user="$2" tmp
  tmp="$(mktemp)"
  dsh_node -e '
const [checkout, serviceUser, httpsPort, publicTarget] = process.argv.slice(1)
process.stdout.write(`${JSON.stringify({ checkout, httpsPort: Number(httpsPort), publicTarget, serviceUser }, null, 2)}\n`)
' "$repo" "$user" "$DSH_HTTPS_PORT" "http://127.0.0.1:$DSH_PUBLIC_PORT" >"$tmp"
  if ! native_install_file_atomically "$tmp" "$DSH_STATE_FILE" 0644; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"
}

native_install() {
  local repo="$1" user passwd group home login_shell unit_tmp updating=0 update_needs_restart=0
  local provider="${DSH_VPN_PROVIDER:-}"
  if [ -z "$provider" ] && [ -f "$DSH_CONFIG_FILE" ]; then
    provider="$(sed -n 's/^DSH_VPN_PROVIDER=//p' "$DSH_CONFIG_FILE")"
  fi
  provider="${provider:-tailscale}"
  dsh_info "Installing the current checkout as persistent $DSH_SERVICE_NAME"
  native_require_root_tools
  [ "${DSH_DEPLOYMENT_LOCK_HELD:-}" = 1 ] || {
    dsh_die "native installation must be invoked as the non-root service user"
    return 1
  }
  [ "$provider" = tailscale ] || [ "$provider" = netbird ] || {
    dsh_die "DSH_VPN_PROVIDER must be tailscale or netbird"
    return 1
  }

  native_restart_interrupted_update() {
    trap - EXIT
    [ "$update_needs_restart" = 1 ] || return 0
    systemctl start "$DSH_SERVICE_NAME" >/dev/null 2>&1 || true
    update_needs_restart=0
  }

  native_stop_for_update() {
    systemctl stop "$DSH_SERVICE_NAME" || {
      dsh_die "failed to stop the installed native service before updating"
      return 1
    }
    update_needs_restart=1
    trap native_restart_interrupted_update EXIT
  }

  user="${DSH_SERVICE_USER:-${SUDO_USER:-}}"
  [ -n "$user" ] || user="$(id -un)"
  [ "$user" != root ] || {
    dsh_die "refusing to run Harness as root; invoke start.sh as the target user"
    return 1
  }
  id "$user" >/dev/null 2>&1 || { dsh_die "service user does not exist: $user"; return 1; }
  passwd="$(getent passwd "$user")" || { dsh_die "passwd entry not found for $user"; return 1; }
  IFS=: read -r _ _ _ _ _ home login_shell <<<"$passwd"
  [ -d "$home" ] || { dsh_die "home directory not found for $user: $home"; return 1; }
  [ -x "$login_shell" ] || { dsh_die "login shell is not executable for $user: $login_shell"; return 1; }
  group="$(id -gn "$user")"
  native_validate_login_shell "$user" "$home" "$login_shell"

  repo="$(readlink -f "$repo")"
  [ -d "$repo/.git" ] || { dsh_die "repository is not a Git checkout root: $repo"; return 1; }
  [ -f "$repo/pnpm-lock.yaml" ] || { dsh_die "pnpm lockfile not found: $repo/pnpm-lock.yaml"; return 1; }
  dsh_info "Checking the $user login-shell toolchain"
  native_require_user_tools "$user" "$home" "$login_shell" "$provider"
  if [ -e "$DSH_UNIT_FILE" ]; then
    native_load_owned_state "$repo" 1
    native_validate_owned_route
    updating=1
  fi
  dsh_reject_duplicate_sidebar "$home"
  if [ "$updating" = 1 ] && [ "$DSH_STATE_CHECKOUT_MISSING" = 0 ]; then
    native_stop_for_update || return 1
  fi
  dsh_info "Preparing the checkout as $user"
  if ! native_prepare_checkout_as_user "$user" "$home" "$login_shell" "$repo"; then
    native_restart_interrupted_update
    return 1
  fi
  if [ "$updating" = 1 ] && [ "$DSH_STATE_CHECKOUT_MISSING" = 1 ]; then
    native_stop_for_update || return 1
  fi

  if [ "$provider" = tailscale ]; then
    dsh_info "Validating the host Tailscale identity and operator"
    systemctl enable --now tailscaled.service >/dev/null || {
      dsh_die "failed to enable and start tailscaled.service"
      return 1
    }
    dsh_load_tailscale_identity
    native_check_operator "$user"
  else
    dsh_info "Validating the host NetBird identity"
    dsh_load_netbird_identity
  fi

  install -d -o root -g root -m 0755 "$(dirname "$DSH_UNIT_FILE")" "$DSH_STATE_DIR"
  native_write_default_config "$DSH_CONFIG_FILE" "$provider" "${DSH_TAILSCALE_LOGIN:-}"
  native_validate_config "$DSH_CONFIG_FILE"
  # shellcheck disable=SC1090 -- native_validate_config accepts only fixed keys.
  source "$DSH_CONFIG_FILE"
  DSH_VPN_PROVIDER="$provider"
  if [ "$provider" = tailscale ]; then
    native_check_route_ownership "http://127.0.0.1:$DSH_PUBLIC_PORT"
  fi

  unit_tmp="$(mktemp --suffix=.service)"
  dsh_info "Installing the root-owned service launcher and proxy configuration"
  native_install_runtime_assets "$repo" || return 1
  if ! native_render_unit "$user" "$group" "$home" "$repo" "$login_shell" "$DSH_INSTALLED_START" "$DSH_CONFIG_FILE" "$provider" >"$unit_tmp"; then
    rm -f "$unit_tmp"
    return 1
  fi
  if ! dsh_run_step "Verifying the generated systemd unit" systemd-analyze verify "$unit_tmp"; then
    rm -f "$unit_tmp"
    dsh_die "generated systemd unit failed verification"
    return 1
  fi
  if ! native_install_file_atomically "$unit_tmp" "$DSH_UNIT_FILE" 0644; then
    rm -f "$unit_tmp"
    return 1
  fi
  rm -f "$unit_tmp"
  dsh_info "Installing the systemd unit and root-owned deployment state"
  systemctl daemon-reload
  update_needs_restart=0
  trap - EXIT

  # State precedes startup so every installed unit remains recoverable after a
  # failed readiness check. A fresh failure removes both artifacts; updates
  # retain their pre-existing ownership record for retry or uninstall.
  if ! native_write_state "$repo" "$user"; then
    if [ "$updating" = 0 ]; then
      rm -f "$DSH_UNIT_FILE" "$DSH_STATE_FILE"
      rm -rf "$DSH_LIBEXEC_DIR"
      systemctl daemon-reload
    fi
    return 1
  fi
  if ! native_start_service "$repo"; then
    if [ "$updating" = 0 ]; then
      systemctl disable --now "$DSH_SERVICE_NAME" >/dev/null 2>&1 || true
      rm -f "$DSH_UNIT_FILE" "$DSH_STATE_FILE"
      rm -rf "$DSH_LIBEXEC_DIR"
      systemctl daemon-reload
      if [ "${DSH_DOCKER_REMOVED:-0}" = 1 ]; then
        dsh_warn "removed the failed fresh native installation after Docker takeover; rerun install after resolving the reported failure"
      else
        dsh_warn "removed the failed fresh native installation; existing external services were not changed"
      fi
    fi
    return 1
  fi
  native_show_urls
  echo "Installed persistent $DSH_SERVICE_NAME; it continues in the background."
  echo "This command is complete. Use './start.sh status' or './start.sh logs' to inspect it."
}

native_uninstall() {
  local repo="$1" actual
  if [ ! -e "$DSH_UNIT_FILE" ]; then
    echo "$DSH_SERVICE_NAME is not installed. Configuration remains at $DSH_CONFIG_FILE."
    return 0
  fi
  native_load_owned_state "$repo"
  native_validate_owned_route
  systemctl disable --now "$DSH_SERVICE_NAME"
  local provider="${DSH_VPN_PROVIDER:-tailscale}"
  if [ "$provider" = tailscale ]; then
    actual="$(native_current_serve_target)" || {
      dsh_die "cannot verify Tailscale Serve cleanup after stopping $DSH_SERVICE_NAME"
      return 1
    }
    [ -z "$actual" ] || [ "$actual" = "$DSH_STATE_TARGET" ] || {
      dsh_die "Tailscale Serve HTTPS port $DSH_STATE_HTTPS_PORT changed ownership while stopping; preserving the unit"
      return 1
    }
    [ -z "$actual" ] || tailscale serve --https="$DSH_STATE_HTTPS_PORT" off
  fi
  rm -f "$DSH_UNIT_FILE"
  rm -rf "$DSH_LIBEXEC_DIR"
  systemctl daemon-reload
  systemctl reset-failed "$DSH_SERVICE_NAME" 2>/dev/null || true
  echo "Removed $DSH_SERVICE_NAME. Configuration and state remain under $DSH_CONFIG_FILE and $DSH_STATE_DIR."
}

native_as_root() {
  local command="$1" repo="$2" node_bin lock_dir="$HOME/.dsh" lock_file="$HOME/.dsh/deployment.lock"
  if [ "$(id -u)" -eq 0 ]; then
    return 2
  fi
  command -v sudo >/dev/null 2>&1 || {
    dsh_die "sudo is required to manage $DSH_SERVICE_NAME"
    return 1
  }
  command -v flock >/dev/null 2>&1 || {
    dsh_die "flock is required to serialize native and Docker deployment"
    return 1
  }
  mkdir -p "$lock_dir"
  [ -d "$lock_dir" ] && [ ! -L "$lock_dir" ] && [ ! -L "$lock_file" ] || {
    dsh_die "$lock_file must be inside a non-symlink directory and must not be a symlink"
    return 1
  }
  node_bin="$(command -v node 2>/dev/null || true)"
  if [ -z "$node_bin" ] && [ -x "${SHELL:-}" ]; then
    node_bin="$("$SHELL" -lc 'command -v node' 2>/dev/null || true)"
  fi
  dsh_info "Authorizing systemd, root-owned configuration, and Tailscale setup with sudo"
  if [ -t 0 ]; then
    sudo -v || return 1
  elif ! sudo -n true 2>/dev/null; then
    dsh_die "sudo authorization needs an interactive terminal; run './start.sh $command' in your shell"
    return 1
  fi
  exec flock "$lock_file" sudo -n env \
    DSH_SERVICE_USER="$(id -un)" \
    DSH_NODE_BIN="$node_bin" \
    DSH_DEPLOYMENT_LOCK_HELD=1 \
    DSH_CALLER_PATH="$PATH" \
    DSH_VERBOSE="${DSH_VERBOSE:-0}" \
     DSH_VPN_PROVIDER="${DSH_VPN_PROVIDER:-}" \
    "$repo/start.sh" "$command"
}

native_show_urls() {
  if [ -f "$DSH_CONFIG_FILE" ]; then
    native_validate_config "$DSH_CONFIG_FILE" || return 1
    # shellcheck disable=SC1090 -- native_validate_config accepts only fixed keys.
    source "$DSH_CONFIG_FILE"
  fi
  local provider="${DSH_VPN_PROVIDER:-tailscale}" public_url
  if [ "$provider" = tailscale ]; then
    dsh_load_tailscale_identity
    public_url="https://$DSH_MAGICDNS/"
    [ "${DSH_HTTPS_PORT:-443}" = 443 ] || public_url="https://$DSH_MAGICDNS:${DSH_HTTPS_PORT}/"
  else
    dsh_load_netbird_identity
    public_url="http://$DSH_NETBIRD_IP:${DSH_PUBLIC_PORT:-4080}/"
  fi
  echo "Web UI: $public_url"
  echo "Local proxy: http://127.0.0.1:${DSH_PUBLIC_PORT:-4080}/"
}

# Reject lifecycle starts whose edited ports no longer match installed state.
native_validate_lifecycle_config() {
  native_validate_config "$DSH_CONFIG_FILE"
  # shellcheck disable=SC1090 -- native_validate_config accepts only fixed keys.
  source "$DSH_CONFIG_FILE"
  [ "$DSH_HTTPS_PORT" = "$DSH_STATE_HTTPS_PORT" ] &&
    [ "http://127.0.0.1:$DSH_PUBLIC_PORT" = "$DSH_STATE_TARGET" ] || {
      dsh_die "service ports changed since installation; run './start.sh install' to apply them safely"
      return 1
    }
}

native_command() {
  local command="$1" repo="$2"
  if [ "$(id -u)" -ne 0 ]; then
    native_as_root "$command" "$repo"
    return
  fi
  case "$command" in
    install) native_install "$repo" ;;
    start|restart)
      native_load_owned_state "$repo"
      native_validate_owned_route
      native_validate_lifecycle_config
      dsh_info "Running '$command' for $DSH_SERVICE_NAME"
      systemctl "$command" "$DSH_SERVICE_NAME"
      dsh_info "$DSH_SERVICE_NAME $command completed"
      ;;
    stop)
      native_load_owned_state "$repo"
      native_validate_owned_route
      dsh_info "Running 'stop' for $DSH_SERVICE_NAME"
      systemctl stop "$DSH_SERVICE_NAME"
      dsh_info "$DSH_SERVICE_NAME stop completed"
      ;;
    status)
      local status=0
      native_load_owned_state "$repo"
      DSH_HTTPS_PORT="$DSH_STATE_HTTPS_PORT"
      DSH_PUBLIC_PORT="${DSH_STATE_TARGET##*:}"
      systemctl status --no-pager --full "$DSH_SERVICE_NAME" || status=$?
      native_show_urls
      return "$status"
      ;;
    logs) exec journalctl -u "$DSH_SERVICE_NAME" -f -n 100 ;;
    uninstall) native_uninstall "$repo" ;;
    *) dsh_die "unsupported native service command: $command" ;;
  esac
}

native_validate_external_file() {
  local file="$1" description="$2" metadata owner mode
  [ -f "$file" ] && [ ! -L "$file" ] || {
    dsh_die "$file must be a non-symlink regular file"
    return 1
  }
  metadata="$(stat -Lc '%u %a' "$file" 2>/dev/null)" || {
    dsh_die "cannot inspect $description: $file"
    return 1
  }
  read -r owner mode <<<"$metadata"
  [ "$owner" = 0 ] || {
    dsh_die "$file must be owned by root"
    return 1
  }
  (( (8#$mode & 8#022) == 0 )) || {
    dsh_die "$file must not be group- or world-writable"
    return 1
  }
}

# Parse the fixed service configuration keys before Bash loads their values.
native_validate_config() {
  local file="$1" name count invalid provider
  native_validate_external_file "$file" "service configuration" || return 1
  invalid="$(grep -Ev '^(#.*|[[:space:]]*|DSH_BACKEND_PORT=[0-9]+|DSH_PUBLIC_PORT=[0-9]+|DSH_HTTPS_PORT=[0-9]+|DSH_STARTUP_TIMEOUT=[0-9]+|DSH_VPN_PROVIDER=(tailscale|netbird)|TAILSCALE_OWNER=[A-Za-z0-9@._+,:=%/-]+|DSH_EXTRA_TRUSTED_HOSTS=[A-Za-z0-9.,:_-]*)$' "$file" || true)"
  [ -z "$invalid" ] || {
    dsh_die "$file contains an unsupported or malformed setting"
    return 1
  }
  provider="$(sed -n 's/^DSH_VPN_PROVIDER=//p' "$file")"
  [ -z "$provider" ] || [ "$provider" = tailscale ] || [ "$provider" = netbird ] || {
    dsh_die "$file must define DSH_VPN_PROVIDER as tailscale or netbird"
    return 1
  }
  if [ "$provider" != netbird ]; then
    count="$(grep -c '^TAILSCALE_OWNER=' "$file" || true)"
    [ "$count" -eq 1 ] || {
      dsh_die "$file must define TAILSCALE_OWNER exactly once for Tailscale"
      return 1
    }
  fi
  for name in \
    DSH_BACKEND_PORT \
    DSH_PUBLIC_PORT \
    DSH_HTTPS_PORT \
    DSH_STARTUP_TIMEOUT \
    DSH_EXTRA_TRUSTED_HOSTS; do
    count="$(grep -c "^${name}=" "$file" || true)"
    [ "$count" -eq 1 ] || {
      dsh_die "$file must define $name exactly once"
      return 1
    }
  done
}

# Wait for any HTTP response while proving its owning child remains alive.
dsh_wait_http_process() {
  local pid="$1" url="$2" timeout="$3" subject="$4" deadline="${5:-$((SECONDS + 10#$timeout))}"
  while (( SECONDS < deadline )); do
    kill -0 "$pid" 2>/dev/null || {
      wait "$pid" 2>/dev/null || true
      dsh_die "$subject exited before becoming ready"
      return 1
    }
    curl -sS --max-time 1 -o /dev/null "$url" 2>/dev/null && return 0
    sleep 1
  done
  dsh_die "$subject did not become ready at $url within ${timeout}s"
}

# Wait for a file while proving its producing child remains alive.
dsh_wait_file_process() {
  local pid="$1" file="$2" timeout="$3" subject="$4" deadline="${5:-$((SECONDS + 10#$timeout))}"
  while (( SECONDS < deadline )); do
    kill -0 "$pid" 2>/dev/null || {
      wait "$pid" 2>/dev/null || true
      dsh_die "$subject exited before becoming ready"
      return 1
    }
    [ -s "$file" ] && return 0
    sleep 1
  done
  dsh_die "$subject did not become ready within ${timeout}s"
}

# Wait for a URL that is not owned by a directly observable child process.
dsh_wait_url() {
  local url="$1" timeout="$2" subject="$3" deadline="${4:-$((SECONDS + 10#$timeout))}"
  local report_url="${5:-$url}"
  while (( SECONDS < deadline )); do
    curl -fsS --max-time 1 -o /dev/null "$url" 2>/dev/null && return 0
    sleep 1
  done
  dsh_die "$subject did not become ready at $report_url within ${timeout}s"
}

# Run Harness, Caddy, and the selected VPN publication as one supervised service.
native_service_run() {
  local config_file="$1" repo="$2" service_user="$3" service_home="$4" login_shell="$5"
  native_validate_config "$config_file"
  # shellcheck disable=SC1090 -- native_validate_config accepts only fixed keys.
  source "$config_file"
  local provider="${DSH_VPN_PROVIDER:-tailscale}" configured_owner="${TAILSCALE_OWNER:-}"
  [ "$provider" = tailscale ] || [ "$provider" = netbird ] || {
    dsh_die "unsupported VPN provider: $provider"
    return 1
  }

  dsh_validate_port DSH_BACKEND_PORT "$DSH_BACKEND_PORT"
  dsh_validate_port DSH_PUBLIC_PORT "$DSH_PUBLIC_PORT"
  dsh_validate_port DSH_HTTPS_PORT "$DSH_HTTPS_PORT"
  [ "$DSH_BACKEND_PORT" != "$DSH_PUBLIC_PORT" ] || {
    dsh_die "DSH_BACKEND_PORT and DSH_PUBLIC_PORT must differ"
    return 1
  }
  [[ "$DSH_STARTUP_TIMEOUT" =~ ^[0-9]+$ ]] && (( 10#$DSH_STARTUP_TIMEOUT >= 1 && 10#$DSH_STARTUP_TIMEOUT <= 3600 )) || {
    dsh_die "DSH_STARTUP_TIMEOUT must be an integer from 1 to 3600"
    return 1
  }
  [ -x "$login_shell" ] || {
    dsh_die "login shell is not executable: $login_shell"
    return 1
  }
  local runtime_root="${DSH_RUNTIME_ROOT:-$repo}"
  [ -f "$runtime_root/deployment/Caddyfile" ] || {
    dsh_die "Caddy configuration not found: $runtime_root/deployment/Caddyfile"
    return 1
  }

  if [ "$provider" = tailscale ]; then
    dsh_load_tailscale_identity
    [ "$configured_owner" = "$DSH_TAILSCALE_LOGIN" ] || {
      dsh_die "configured TAILSCALE_OWNER $configured_owner does not match connected owner $DSH_TAILSCALE_LOGIN"
      return 1
    }
  else
    dsh_load_netbird_identity
  fi

  local runtime_directory="${RUNTIME_DIRECTORY:-$DSH_SERVICE_RUNTIME_DIR}"
  local backend_launcher="$runtime_directory/launch-backend"
  local backend_url_file="$runtime_directory/backend-url"
  local token backend_pid="" caddy_pid="" serve_published=0 child_status=0
  local proxy_bind_address="${DSH_TAILSCALE_IP:-${DSH_NETBIRD_IP:-127.0.0.1}}"
  mkdir -p "$runtime_directory"
  [ -x "${DSH_NODE_BIN:-}" ] || DSH_NODE_BIN="$("$login_shell" -lc 'command -v node')"
  [ -x "$DSH_NODE_BIN" ] || {
    dsh_die "Node.js is unavailable through the service login shell"
    return 1
  }
  [ -x "${DSH_PNPM_BIN:-}" ] || DSH_PNPM_BIN="$("$login_shell" -lc 'command -v pnpm')"
  [ -x "$DSH_PNPM_BIN" ] || {
    dsh_die "pnpm is unavailable through the service login shell"
    return 1
  }
  export DSH_NODE_BIN DSH_PNPM_BIN
  token="$(dsh_node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  cat >"$backend_launcher" <<'BACKEND'
#!/usr/bin/env bash
set -euo pipefail
overlay_ip="${DSH_TAILSCALE_IP:-$DSH_NETBIRD_IP}"
args=(dsh web --no-open --port "$DSH_PORT" --trusted-host "$overlay_ip")
[ -z "${DSH_MAGICDNS:-}" ] || args+=(--trusted-host "$DSH_MAGICDNS")
IFS=',' read -ra extra_hosts <<<"${DSH_EXTRA_TRUSTED_HOSTS:-}"
for host in "${extra_hosts[@]}"; do
  [ -z "$host" ] || args+=(--trusted-host "$host")
done
PATH="${DSH_NODE_BIN%/*}:$PATH" "$DSH_PNPM_BIN" "${args[@]}" | while IFS= read -r line; do
  case "$line" in
    "dsh web: http://127.0.0.1:${DSH_PORT}/?token="*)
      launch_url="${line#dsh web: }"
      launch_url="${launch_url%% *}"
      printf '%s\n' "$launch_url" >"$DSH_BACKEND_URL_FILE.tmp"
      chmod 0600 "$DSH_BACKEND_URL_FILE.tmp"
      mv -f "$DSH_BACKEND_URL_FILE.tmp" "$DSH_BACKEND_URL_FILE"
      printf '%s\n' 'dsh web: launch URL captured for the installer'
      ;;
    *) printf '%s\n' "$line" ;;
  esac
done
BACKEND
  chmod 0600 "$backend_launcher"
  rm -f "$backend_url_file" "$backend_url_file.tmp"

  cleanup_native_runtime() {
    trap - INT TERM EXIT
    [ -z "$backend_pid" ] || kill -- "-$backend_pid" 2>/dev/null || true
    [ -z "$caddy_pid" ] || kill -- "-$caddy_pid" 2>/dev/null || true
    [ -z "$backend_pid" ] || wait "$backend_pid" 2>/dev/null || true
    [ -z "$caddy_pid" ] || wait "$caddy_pid" 2>/dev/null || true
    if [ "$serve_published" = 1 ]; then
      local cleanup_target expected_target="http://127.0.0.1:$DSH_PUBLIC_PORT"
      if cleanup_target="$(native_current_serve_target)" && [ "$cleanup_target" = "$expected_target" ]; then
        tailscale serve --https="$DSH_HTTPS_PORT" off >/dev/null 2>&1 || true
      elif [ -n "${cleanup_target:-}" ]; then
        dsh_warn "leaving Tailscale Serve route owned by $cleanup_target"
      else
        dsh_warn "could not prove ownership of the Tailscale Serve route; leaving it unchanged"
      fi
    fi
    rm -f "$backend_launcher" "$backend_url_file" "$backend_url_file.tmp"
  }
  trap 'cleanup_native_runtime; exit 130' INT
  trap 'cleanup_native_runtime; exit 143' TERM
  trap cleanup_native_runtime EXIT

  export DSH_BACKEND_LAUNCHER="$backend_launcher"
  export DSH_BACKEND_URL_FILE="$backend_url_file"
  export DSH_EXTRA_TRUSTED_HOSTS DSH_MAGICDNS DSH_TAILSCALE_IP DSH_NETBIRD_IP DSH_VPN_PROVIDER
  # Hardened hosts may mount the systemd runtime directory with noexec.
  # Only this supervisor owns systemd readiness notifications.
  NOTIFY_SOCKET= \
    HOME="$service_home" \
    USER="$service_user" \
    DSH_HOME="$service_home/.dsh" \
    DSH_PORT="$DSH_BACKEND_PORT" \
    DSH_TASK_BOARD_PROXY_TOKEN="$token" \
    setsid "$login_shell" -lc 'exec bash "$DSH_BACKEND_LAUNCHER"' &
  backend_pid=$!

  local public_url
  if [ "$provider" = tailscale ]; then
    public_url="https://$DSH_MAGICDNS/"
    [ "$DSH_HTTPS_PORT" = 443 ] || public_url="https://$DSH_MAGICDNS:$DSH_HTTPS_PORT/"
  else
    public_url="http://$DSH_NETBIRD_IP:$DSH_PUBLIC_PORT/"
  fi

  native_runtime_until_exit() {
    local startup_deadline=$((SECONDS + 10#$DSH_STARTUP_TIMEOUT)) launch_url launch_token
    systemd-notify --status="Waiting for the Harness backend" 2>/dev/null || true
    dsh_wait_file_process "$backend_pid" "$backend_url_file" "$DSH_STARTUP_TIMEOUT" "Harness backend" "$startup_deadline" || return $?
    IFS= read -r launch_url <"$backend_url_file"
    launch_token="${launch_url#*\?token=}"
    NOTIFY_SOCKET= \
      HOME="$service_home" \
      USER="$service_user" \
      DSH_CADDY_CONFIG="$runtime_root/deployment/Caddyfile" \
      DSH_BROWSER_LAUNCH_TOKEN="$launch_token" \
      DSH_TASK_BOARD_PROXY_TOKEN="$token" \
      DSH_BACKEND_PORT="$DSH_BACKEND_PORT" \
      DSH_PUBLIC_PORT="$DSH_PUBLIC_PORT" \
       DSH_VPN_PROVIDER="$provider" \
       DSH_BIND_ADDRESS="$proxy_bind_address" \
      TAILSCALE_OWNER="${configured_owner:-__netbird_unused__}" \
      setsid "$login_shell" -lc 'exec caddy run --config "$DSH_CADDY_CONFIG" --adapter caddyfile' &
    caddy_pid=$!
    systemd-notify --status="Waiting for the Caddy identity proxy" 2>/dev/null || true
    dsh_wait_http_process "$caddy_pid" "http://$proxy_bind_address:$DSH_PUBLIC_PORT/" "$DSH_STARTUP_TIMEOUT" "Caddy proxy" "$startup_deadline" || return $?
    systemd-notify --status="Checking browser authentication" 2>/dev/null || true
    if [ "$provider" = tailscale ]; then
      dsh_probe_identity_proxy "http://127.0.0.1:$DSH_PUBLIC_PORT" "$DSH_MAGICDNS" "$configured_owner" "$launch_url" "$startup_deadline" || return $?
      systemd-notify --status="Publishing Tailscale HTTPS" 2>/dev/null || true
      tailscale serve --yes --bg --https="$DSH_HTTPS_PORT" "http://127.0.0.1:$DSH_PUBLIC_PORT" || {
        dsh_die "failed to publish $public_url with Tailscale Serve"
        return 1
      }
      serve_published=1
      dsh_wait_url "$public_url" "$DSH_STARTUP_TIMEOUT" "Tailscale HTTPS" "$startup_deadline" || return $?
    else
      dsh_wait_url "$public_url" "$DSH_STARTUP_TIMEOUT" "NetBird HTTP" "$startup_deadline" || return $?
    fi
    kill -0 "$backend_pid" 2>/dev/null || {
      dsh_die "Harness backend exited before service readiness"
      return 1
    }
    kill -0 "$caddy_pid" 2>/dev/null || {
      dsh_die "Caddy proxy exited before service readiness"
      return 1
    }
    if [ -n "${NOTIFY_SOCKET:-}" ]; then
      systemd-notify --ready --status="Serving $public_url" || return $?
    fi
    local exited_pid="" exit_status=0
    wait -n -p exited_pid "$backend_pid" "$caddy_pid" || exit_status=$?
    if [ "$exited_pid" = "$backend_pid" ]; then
      dsh_die "Harness backend exited after readiness (status $exit_status)"
    else
      dsh_die "Caddy proxy exited after readiness (status $exit_status)"
    fi
  }

  set +e
  native_runtime_until_exit
  child_status=$?
  set -e
  cleanup_native_runtime
  return "$child_status"
}

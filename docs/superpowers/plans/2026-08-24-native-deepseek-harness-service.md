# Native DeepSeek Harness Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `start.sh` as a host-native, reboot-persistent `deepseek-harness.service` with the Docker deployment's host-node Tailscale identity policy and the installing user's complete host environment.

**Architecture:** One non-root systemd service supervises source-launched Harness and host Caddy in one cgroup, then publishes the loopback Caddy endpoint through the host Tailscale node. Native and Docker launchers share checkout, profile, identity, proxy, readiness, and locking helpers; native installation proves ownership before replacing Docker and rolls back exact containers if readiness fails.

**Tech Stack:** Bash 5, systemd, Tailscale Serve, Caddy 2, Node.js, pnpm, Vitest, Docker/Podman Compose stubs.

## Global Constraints

- Support systemd-based Ubuntu, Fedora, and Arch Linux.
- Validate dependencies and print exact distribution guidance; never invoke an OS package manager.
- Run Harness as the invoking non-root user with that account's supplementary groups and login environment.
- Use the current checkout in place; moving it requires reinstalling the unit.
- Use the host's existing connected Tailscale node only; do not add `TS_AUTHKEY` or a second `tailscaled` instance.
- Preserve the current Caddy owner-sensitive routes and task-board token behavior.
- Bind Harness and Caddy to loopback only; publish HTTPS through Tailscale Serve.
- Build and validate before stopping a working deployment.
- Replace only a Docker Harness deployment whose checkout, Compose labels, containers, route, and target all match.
- Roll back the exact stopped Docker containers when native readiness fails.
- Do not grant permissions, credentials, groups, sudo rights, or filesystem access the service user does not already possess.
- Preserve unrelated dirty-worktree changes and commit only each task's paths.

---

## File Structure

- Create `start.sh`: public command parser, privilege transition, and internal systemd entry point.
- Create `scripts/deployment/common.sh`: side-effect-free shared validation, checkout, profile, Tailscale identity, proxy probe, and lock functions.
- Create `scripts/deployment/native-service.sh`: unit/config/state rendering, native process supervision, installer lifecycle, Docker migration, and rollback functions sourced by `start.sh`.
- Create `scripts/verify-deployment-artifacts.mjs`: print the checkout artifacts missing after a deployment build.
- Move `docker/Caddyfile` to `deployment/Caddyfile`: one proxy policy consumed by native Caddy and Docker Compose.
- Modify `run-docker.sh`: source shared helpers, use the shared deployment lock, and retain Docker-specific runtime/toolchain behavior.
- Modify `docker/docker-compose.yml`: mount the deployment-neutral Caddyfile.
- Modify `scripts/run-docker.spec.ts`: pin the shared Caddyfile path and unchanged Docker behavior.
- Create `scripts/start.spec.ts`: keyless native launcher, systemd, readiness, lifecycle, migration, and rollback coverage.
- Create `deployment/README.md`, `deployment/README.zh.md`, and `deployment/README.i18n.yaml`: native installation and operations reference.
- Modify `README.md`, `README.zh.md`, and `README.i18n.yaml`: list native and Docker deployment choices.
- Modify `docker/README.md`, `docker/README.zh.md`, and `docker/README.i18n.yaml`: link the mutually exclusive native alternative.
- Create an implemented bilingual Agent Note for the host-native service, then archive the superseded host-launcher-removal note through the repository's Agent Note workflow.

---

### Task 1: Extract shared deployment policy and Caddy configuration

**Files:**
- Create: `scripts/deployment/common.sh`
- Create: `scripts/verify-deployment-artifacts.mjs`
- Move: `docker/Caddyfile` → `deployment/Caddyfile`
- Modify: `docker/docker-compose.yml:97-104`
- Modify: `run-docker.sh:8-23,171-234,300-415`
- Modify: `scripts/run-docker.spec.ts:14-34,82-321`

**Interfaces:**
- Produces: `dsh_acquire_deployment_lock USER_HOME`, `dsh_validate_port NAME VALUE`, `dsh_reject_duplicate_sidebar USER_HOME`, `dsh_prepare_checkout REPO PNPM_BIN`, `dsh_load_tailscale_identity`, and `dsh_probe_identity_proxy PROXY MAGICDNS OWNER`.
- Produces globals after `dsh_load_tailscale_identity`: `DSH_MAGICDNS`, `DSH_TAILSCALE_IP`, and `TAILSCALE_OWNER`.
- Preserves: all current `run-docker.sh` user-visible diagnostics and launcher ordering except that the lock moves to `~/.dsh/deployment.lock`.

- [ ] **Step 1: Write failing shared-policy assertions**

Update `scripts/run-docker.spec.ts` to consume the neutral Caddy path and assert the shared helper and lock are used:

```ts
const caddyfile = join(repository, 'deployment/Caddyfile')
const commonDeployment = join(repository, 'scripts/deployment/common.sh')

it('shares deployment identity and locking policy', () => {
  const launcherSource = readFileSync(launcher, 'utf8')
  const commonSource = readFileSync(commonDeployment, 'utf8')
  const composeSource = readFileSync(join(repository, 'docker/docker-compose.yml'), 'utf8')
  expect(launcherSource).toContain('source "$SCRIPT_DIR/scripts/deployment/common.sh"')
  expect(launcherSource).toContain('dsh_acquire_deployment_lock "$DSH_HOST_USER_HOME"')
  expect(commonSource).toContain('dsh_probe_identity_proxy()')
  expect(composeSource).toContain('../deployment/Caddyfile:/etc/caddy/Caddyfile:ro')
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run scripts/run-docker.spec.ts -t 'shares deployment identity and locking policy'
```

Expected: FAIL because `scripts/deployment/common.sh` and `deployment/Caddyfile` do not exist.

- [ ] **Step 3: Add the shared shell API and move the Caddyfile**

Create `scripts/deployment/common.sh` with no top-level side effects beyond function definitions:

```bash
#!/usr/bin/env bash

dsh_die() { echo "error: $*" >&2; return 1; }
dsh_warn() { echo "warning: $*" >&2; }

dsh_validate_port() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] && (( 10#$value >= 1 && 10#$value <= 65535 )) || {
    dsh_die "$name must be an integer from 1 to 65535"
    return 1
  }
}

dsh_acquire_deployment_lock() {
  local home="$1" lock_dir="$1/.dsh"
  mkdir -p "$lock_dir"
  exec 9>"$lock_dir/deployment.lock"
  flock 9
}

dsh_reject_duplicate_sidebar() {
  local home="$1" profile_manifest="$1/.dsh/profiles/web/package.json"
  [ -f "$profile_manifest" ] || return 0
  node - "$profile_manifest" <<'NODE'
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

dsh_prepare_checkout() {
  local repo="$1" pnpm_bin="$2" missing
  "$pnpm_bin" --dir "$repo" install --frozen-lockfile || {
    dsh_die "checkout dependency installation failed: $repo"
    return 1
  }
  "$pnpm_bin" --dir "$repo" run build || {
    dsh_die "checkout build failed: $repo"
    return 1
  }
  missing="$(node "$repo/scripts/verify-deployment-artifacts.mjs" "$repo")" || return 1
  [ -z "$missing" ] || dsh_die "checkout build omitted required artifacts: $missing"
}

dsh_load_tailscale_identity() {
  local status parsed
  status="$(tailscale status --json 2>/dev/null)" || {
    dsh_die "Tailscale status unavailable; connect this host with 'tailscale up'"
    return 1
  }
  parsed="$(printf '%s' "$status" | node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const j = JSON.parse(s)
  const self = j.Self ?? {}
  const dns = String(self.DNSName ?? "").replace(/\.$/, "")
  const state = String(j.BackendState ?? "Running")
  const owner = String(j.User?.[self.UserID]?.LoginName ?? "")
  process.stdout.write([dns, state, owner].join("\t"))
})')" || { dsh_die "Tailscale returned invalid status JSON"; return 1; }
  IFS=$'\t' read -r DSH_MAGICDNS backend_state TAILSCALE_OWNER <<<"$parsed"
  [ "$backend_state" = Running ] || { dsh_die "Tailscale is not connected"; return 1; }
  [ -n "$DSH_MAGICDNS" ] || { dsh_die "Tailscale MagicDNS name unavailable"; return 1; }
  [ -n "$TAILSCALE_OWNER" ] || { dsh_die "Tailscale owner login unavailable"; return 1; }
  DSH_TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | head -n1)"
  [ -n "$DSH_TAILSCALE_IP" ] || { dsh_die "Tailscale IPv4 address unavailable"; return 1; }
  export DSH_MAGICDNS DSH_TAILSCALE_IP TAILSCALE_OWNER
}

dsh_probe_identity_proxy() {
  local proxy="$1" magicdns="$2" owner="$3" denied allowed
  local probe=( -sS -o /dev/null -w '%{http_code}' -X POST "$proxy/api/settings.describe" -H "Host: $magicdns" -H "Origin: https://$magicdns" -H 'content-type: application/json' --data '{}' )
  denied="$(curl "${probe[@]}" -H 'Tailscale-User-Login: unauthorized@example.invalid')" || return 1
  allowed="$(curl "${probe[@]}" -H "Tailscale-User-Login: $owner")" || return 1
  [ "$denied" = 403 ] && [ "$allowed" = 200 ] || dsh_die "Tailscale identity proxy self-check failed (denied=$denied allowed=$allowed)"
}
```

Create `scripts/verify-deployment-artifacts.mjs` as the extracted form of the existing inline check:

```js
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = process.argv[2]
if (!repo) throw new Error('usage: verify-deployment-artifacts.mjs <repository>')
const missing = []
if (!existsSync(join(repo, 'node_modules'))) missing.push('node_modules')
if (!existsSync(join(repo, 'apps/web/dist/index.html'))) missing.push('apps/web/dist/index.html')
for (const directory of readdirSync(join(repo, 'packages/client'))) {
  const packageDirectory = join(repo, 'packages/client', directory)
  const manifestPath = join(packageDirectory, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dsh?.client && !existsSync(join(packageDirectory, 'lib/client.js'))) missing.push(`${directory}/lib/client.js`)
}
process.stdout.write(missing.join(', '))
```

Move the existing Caddyfile without changing its route list, update Compose to mount `../deployment/Caddyfile`, and replace equivalent inline blocks in `run-docker.sh` with these functions.

- [ ] **Step 4: Run Docker regressions and shell syntax**

Run:

```bash
pnpm exec vitest run scripts/run-docker.spec.ts
bash -n run-docker.sh scripts/deployment/common.sh
```

Expected: 5 tests PASS; `bash -n` exits 0.

- [ ] **Step 5: Commit the shared deployment policy**

```bash
git add scripts/deployment/common.sh scripts/verify-deployment-artifacts.mjs deployment/Caddyfile docker/Caddyfile docker/docker-compose.yml run-docker.sh scripts/run-docker.spec.ts
git commit -m "refactor(deploy): share Tailscale launch policy"
```

---

### Task 2: Add native runtime supervision and readiness

**Files:**
- Create: `scripts/deployment/native-service.sh`
- Create: `scripts/start.spec.ts`
- Create: `start.sh`

**Interfaces:**
- Consumes: Task 1 shared functions and `deployment/Caddyfile`.
- Produces: `native_validate_config PATH`, `native_service_run CONFIG_FILE REPO SERVICE_USER SERVICE_HOME LOGIN_SHELL`, and `native_usage`.
- Internal process entry: `./start.sh __service CONFIG_FILE REPO SERVICE_USER SERVICE_HOME LOGIN_SHELL`.

- [ ] **Step 1: Write the failing runtime supervision test**

Create `scripts/start.spec.ts` with a reusable executable fixture and a test that stubs `pnpm`, `caddy`, `tailscale`, `curl`, and `systemd-notify`:

```ts
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '..')
const launcher = join(repository, 'start.sh')

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}`)
  chmodSync(path, 0o755)
}

describe('native Harness runtime', () => {
  it.runIf(process.platform === 'linux')('reports ready only after both identity probes pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-runtime-'))
    const bin = join(root, 'bin')
    const calls = join(root, 'calls.log')
    const config = join(root, 'service.env')
    mkdirSync(bin)
    writeFileSync(config, 'DSH_BACKEND_PORT=4081\nDSH_PUBLIC_PORT=4080\nDSH_HTTPS_PORT=443\nDSH_STARTUP_TIMEOUT=3\nTAILSCALE_OWNER=owner@example.test\nDSH_EXTRA_TRUSTED_HOSTS=\n')
    executable(join(bin, 'pnpm'), 'trap "exit 0" TERM INT; while :; do sleep 1; done')
    executable(join(bin, 'caddy'), 'trap "exit 0" TERM INT; while :; do sleep 1; done')
    executable(join(bin, 'tailscale'), 'case "$*" in "status --json") echo '\''{"BackendState":"Running","Self":{"DNSName":"host.tail.test.","UserID":1},"User":{"1":{"LoginName":"owner@example.test"}}}'\'' ;; "ip -4") echo 100.64.0.1 ;; *) printf "tailscale %s\\n" "$*" >> "$CALLS" ;; esac')
    executable(join(bin, 'curl'), 'case "$*" in *unauthorized@example.invalid*) printf 403 ;; *owner@example.test*) printf 200 ;; *host.tail.test*) exit 0 ;; *) exit 0 ;; esac')
    executable(join(bin, 'systemd-notify'), 'printf "notify %s\\n" "$*" >> "$CALLS"')
    const child = spawn(launcher, ['__service', config, repository, process.env.USER ?? 'node', process.env.HOME ?? root, '/bin/bash'], { env: { ...process.env, CALLS: calls, PATH: `${bin}:${process.env.PATH ?? ''}` } })
    await new Promise(resolveWait => setTimeout(resolveWait, 300))
    child.kill('SIGTERM')
    await new Promise(resolveExit => child.once('exit', resolveExit))
    expect(readFileSync(calls, 'utf8')).toContain('notify --ready')
    expect(readFileSync(calls, 'utf8')).toContain('tailscale serve --yes --bg --https=443 http://127.0.0.1:4080')
  })
})
```

Replace timer-based waiting during implementation with a call-log polling helper in the final test so the test observes readiness rather than sleeping.

- [ ] **Step 2: Run the runtime test and verify RED**

```bash
pnpm exec vitest run scripts/start.spec.ts -t 'reports ready only after both identity probes pass'
```

Expected: FAIL with `spawn .../start.sh ENOENT`.

- [ ] **Step 3: Implement the minimal supervised runtime**

Create `start.sh` as a source-safe dispatcher:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
source "$SCRIPT_DIR/scripts/deployment/common.sh"
source "$SCRIPT_DIR/scripts/deployment/native-service.sh"

native_usage() {
  printf '%s\n' 'Usage: ./start.sh [install|start|stop|restart|status|logs|uninstall|help]'
}

main() {
  case "${1:-install}" in
    __service) shift; native_service_run "$@" ;;
    install|start|stop|restart|status|logs|uninstall) native_command "${1:-install}" "$SCRIPT_DIR" ;;
    help|-h|--help) native_usage ;;
    *) dsh_die "unknown command: $1 (run './start.sh help')" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
```

Create `scripts/deployment/native-service.sh` with an exact-key parser and `native_service_run`. Task 3 adds ownership and mode checks to the parser before installation:

```bash
native_validate_config() {
  local file="$1" name value count
  [ -f "$file" ] && [ ! -L "$file" ] || { dsh_die "$file must be a non-symlink regular file"; return 1; }
  for name in DSH_BACKEND_PORT DSH_PUBLIC_PORT DSH_HTTPS_PORT DSH_STARTUP_TIMEOUT TAILSCALE_OWNER DSH_EXTRA_TRUSTED_HOSTS; do
    count="$(grep -c "^${name}=" "$file" || true)"
    [ "$count" -eq 1 ] || { dsh_die "$file must define $name exactly once"; return 1; }
    value="$(sed -n "s/^${name}=//p" "$file")"
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { dsh_die "$name must not contain line breaks"; return 1; }
  done
}

native_service_run() {
  local config_file="$1" repo="$2" service_user="$3" service_home="$4" login_shell="$5"
  native_validate_config "$config_file"
  # shellcheck disable=SC1090 -- native_validate_config accepts only the root-owned service input.
  source "$config_file"
  local configured_owner="$TAILSCALE_OWNER"
  dsh_validate_port DSH_BACKEND_PORT "$DSH_BACKEND_PORT"
  dsh_validate_port DSH_PUBLIC_PORT "$DSH_PUBLIC_PORT"
  dsh_validate_port DSH_HTTPS_PORT "$DSH_HTTPS_PORT"
  [ "$DSH_BACKEND_PORT" != "$DSH_PUBLIC_PORT" ] || { dsh_die "DSH_BACKEND_PORT and DSH_PUBLIC_PORT must differ"; return 1; }
  dsh_load_tailscale_identity
  [ "$TAILSCALE_OWNER" = "$configured_owner" ] || { dsh_die "configured TAILSCALE_OWNER does not match the connected node owner"; return 1; }

  local token backend_pid="" caddy_pid=""
  token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  cleanup_native_runtime() {
    trap - INT TERM EXIT
    tailscale serve --https="$DSH_HTTPS_PORT" off >/dev/null 2>&1 || true
    [ -z "$backend_pid" ] || kill "$backend_pid" 2>/dev/null || true
    [ -z "$caddy_pid" ] || kill "$caddy_pid" 2>/dev/null || true
    [ -z "$backend_pid" ] || wait "$backend_pid" 2>/dev/null || true
    [ -z "$caddy_pid" ] || wait "$caddy_pid" 2>/dev/null || true
  }
  trap cleanup_native_runtime INT TERM EXIT

  local backend_launcher="${RUNTIME_DIRECTORY:-/run/deepseek-harness}/launch-backend"
  cat >"$backend_launcher" <<'BACKEND'
#!/usr/bin/env bash
set -euo pipefail
args=(dsh web --no-open --port "$DSH_PORT" --trusted-host "$DSH_MAGICDNS" --trusted-host "$DSH_TAILSCALE_IP")
IFS=',' read -ra extra_hosts <<<"${DSH_EXTRA_TRUSTED_HOSTS:-}"
for host in "${extra_hosts[@]}"; do [ -z "$host" ] || args+=(--trusted-host "$host"); done
exec pnpm "${args[@]}"
BACKEND
  chmod 0700 "$backend_launcher"
  export DSH_BACKEND_LAUNCHER="$backend_launcher" DSH_MAGICDNS DSH_TAILSCALE_IP DSH_EXTRA_TRUSTED_HOSTS
  HOME="$service_home" USER="$service_user" DSH_HOME="$service_home/.dsh" DSH_PORT="$DSH_BACKEND_PORT" DSH_TASK_BOARD_PROXY_TOKEN="$token" \
    "$login_shell" -lc 'exec "$DSH_BACKEND_LAUNCHER"' &
  backend_pid=$!
  DSH_TASK_BOARD_PROXY_TOKEN="$token" DSH_BACKEND_PORT="$DSH_BACKEND_PORT" DSH_PUBLIC_PORT="$DSH_PUBLIC_PORT" TAILSCALE_OWNER="$TAILSCALE_OWNER" \
    caddy run --config "$repo/deployment/Caddyfile" --adapter caddyfile &
  caddy_pid=$!

  dsh_wait_http_process "$backend_pid" "http://127.0.0.1:$DSH_BACKEND_PORT/" "$DSH_STARTUP_TIMEOUT" "Harness backend"
  dsh_wait_http_process "$caddy_pid" "http://127.0.0.1:$DSH_PUBLIC_PORT/" "$DSH_STARTUP_TIMEOUT" "Caddy proxy"
  dsh_probe_identity_proxy "http://127.0.0.1:$DSH_PUBLIC_PORT" "$DSH_MAGICDNS" "$TAILSCALE_OWNER"
  tailscale serve --yes --bg --https="$DSH_HTTPS_PORT" "http://127.0.0.1:$DSH_PUBLIC_PORT"
  dsh_wait_url "https://$DSH_MAGICDNS:$DSH_HTTPS_PORT/" "$DSH_STARTUP_TIMEOUT" "Tailscale HTTPS"
  [ -z "${NOTIFY_SOCKET:-}" ] || systemd-notify --ready --status="Serving https://$DSH_MAGICDNS/"

  wait -n "$backend_pid" "$caddy_pid"
}
```

Implement `dsh_wait_http_process` and `dsh_wait_url` in `common.sh` as bounded one-second probe loops that fail immediately when the owned PID exits and name the failed subject and timeout.

- [ ] **Step 4: Add sibling-exit and denied-owner tests**

Add tests that make fake Caddy exit with status 7 and assert fake pnpm receives `TERM`, then make the owner probe return 403 and assert no `systemd-notify --ready` call exists:

```ts
expect(result.status).toBe(7)
expect(readFileSync(calls, 'utf8')).toContain('backend TERM')
expect(readFileSync(calls, 'utf8')).not.toContain('notify --ready')
```

- [ ] **Step 5: Run runtime tests and syntax checks**

```bash
pnpm exec vitest run scripts/start.spec.ts -t 'native Harness runtime'
bash -n start.sh scripts/deployment/common.sh scripts/deployment/native-service.sh
pnpm exec oxlint scripts/start.spec.ts
```

Expected: runtime tests PASS, Bash exits 0, Oxlint reports no errors.

- [ ] **Step 6: Commit the native runtime**

```bash
git add start.sh scripts/deployment/common.sh scripts/deployment/native-service.sh scripts/start.spec.ts
git commit -m "feat(deploy): supervise native Harness runtime"
```

---

### Task 3: Install and manage the systemd service

**Files:**
- Modify: `start.sh`
- Modify: `scripts/deployment/native-service.sh`
- Modify: `scripts/start.spec.ts`

**Interfaces:**
- Produces: `native_command COMMAND REPO`, `native_render_unit USER GROUP HOME REPO LOGIN_SHELL START_PATH CONFIG_PATH`, `native_write_default_config PATH OWNER`, hardened `native_validate_config PATH`, `native_start_and_verify`, and `native_show_urls`.
- Installs: `/etc/systemd/system/deepseek-harness.service`, `/etc/deepseek-harness.env`, and `/var/lib/deepseek-harness/deployment.json`.
- Public command behavior matches the command table in the design specification.

- [ ] **Step 1: Write failing unit/config rendering tests**

Source the library in a child Bash process and assert exact security and runtime fields:

```ts
const rendered = spawnSync('bash', ['-c', `source "$1/scripts/deployment/common.sh"; source "$1/scripts/deployment/native-service.sh"; native_render_unit node node /home/node "$1" /bin/bash "$1/start.sh" /etc/deepseek-harness.env`, '_', repository], { encoding: 'utf8' })
expect(rendered.status).toBe(0)
expect(rendered.stdout).toContain('Description=DeepSeek Harness')
expect(rendered.stdout).toContain('Type=notify')
expect(rendered.stdout).toContain('User=node')
expect(rendered.stdout).toContain('Group=node')
expect(rendered.stdout).toContain('WorkingDirectory=')
expect(rendered.stdout).toContain('RuntimeDirectory=deepseek-harness')
expect(rendered.stdout).toContain('UMask=0077')
expect(rendered.stdout).toContain('KillMode=mixed')
expect(rendered.stdout).toContain('ExecStart=')
expect(rendered.stdout).not.toContain('ProtectHome=')
expect(rendered.stdout).not.toContain('NoNewPrivileges=')
```

Add config tests for a root-owned regular-file fixture through injectable function arguments; reject a symlink, mode `0666`, duplicate keys, equal ports, and a value containing a newline.

- [ ] **Step 2: Run rendering tests and verify RED**

```bash
pnpm exec vitest run scripts/start.spec.ts -t 'renders|rejects native configuration'
```

Expected: FAIL because rendering and configuration functions are undefined.

- [ ] **Step 3: Implement rendering and validated atomic installation**

Add constants and render functions to `native-service.sh`:

```bash
DSH_SERVICE_NAME=deepseek-harness.service
DSH_UNIT_FILE=/etc/systemd/system/$DSH_SERVICE_NAME
DSH_CONFIG_FILE=/etc/deepseek-harness.env
DSH_STATE_DIR=/var/lib/deepseek-harness
DSH_STATE_FILE=$DSH_STATE_DIR/deployment.json

native_write_default_config() {
  local path="$1" owner="$2"
  [ -e "$path" ] && return 0
  local tmp
  tmp="$(mktemp "${path}.XXXXXX")"
  cat >"$tmp" <<EOF
DSH_BACKEND_PORT=4081
DSH_PUBLIC_PORT=4080
DSH_HTTPS_PORT=443
DSH_STARTUP_TIMEOUT=90
TAILSCALE_OWNER=$owner
DSH_EXTRA_TRUSTED_HOSTS=
EOF
  chmod 0644 "$tmp"
  chown root:root "$tmp"
  mv -T "$tmp" "$path"
}

native_systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

native_render_unit() {
  local user="$1" group="$2" home="$3" repo="$4" login_shell="$5" start_path="$6" config_path="$7"
  cat <<EOF
[Unit]
Description=DeepSeek Harness
Wants=network-online.target
After=network-online.target tailscaled.service
Requires=tailscaled.service
PartOf=tailscaled.service
StartLimitIntervalSec=0

[Service]
Type=notify
NotifyAccess=main
User=$user
Group=$group
WorkingDirectory=$(native_systemd_quote "$repo")
Environment=$(native_systemd_quote "HOME=$home")
Environment=$(native_systemd_quote "USER=$user")
Environment=$(native_systemd_quote "DSH_HOME=$home/.dsh")
EnvironmentFile=$(native_systemd_quote "$config_path")
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
```

Before installing a rendered unit, validate every dynamic value with `native_validate_systemd_value`, canonicalize paths with `readlink -f`, verify the existing config is root-owned/non-symlink/non-writable, render into a same-directory temporary file, run `systemd-analyze verify`, then `install -o root -g root -m 0644` and `systemctl daemon-reload`.

- [ ] **Step 4: Implement service-user and login-environment preflight**

Resolve the target user from `DSH_SERVICE_USER`, `SUDO_USER`, or the invoking user; refuse `root`. Resolve home and shell from `getent passwd`. Verify dependencies through the login shell without installing them:

```bash
native_login_exec() {
  local user="$1" home="$2" shell="$3" command="$4"
  runuser -u "$user" -- env HOME="$home" USER="$user" "$shell" -lc "$command"
}

native_require_user_tools() {
  local user="$1" home="$2" shell="$3" missing=() tool
  for tool in node pnpm git curl caddy tailscale; do
    native_login_exec "$user" "$home" "$shell" "command -v '$tool' >/dev/null" || missing+=("$tool")
  done
  [ "${#missing[@]}" -eq 0 ] || {
    native_dependency_guidance "${missing[@]}"
    return 1
  }
}
```

`native_dependency_guidance` reads `/etc/os-release` and prints one exact command for Ubuntu, Fedora, or Arch, while stating that Node must satisfy `^22.19.0 || >=24.0.0` and pnpm must be `11.7.0`; it returns failure without executing the command.

- [ ] **Step 5: Implement public lifecycle commands**

`install` performs preflight, shared profile rejection, shared checkout preparation as the service user, Tailscale operator and route checks, atomic unit/config installation, `systemctl enable --now`, and readiness inspection. Other commands map exactly:

```bash
case "$command" in
  start|stop|restart) as_root systemctl "$command" "$DSH_SERVICE_NAME" ;;
  status) as_root systemctl status --no-pager --full "$DSH_SERVICE_NAME"; native_show_urls ;;
  logs) exec sudo journalctl -u "$DSH_SERVICE_NAME" -f -n 100 ;;
  uninstall) native_uninstall ;;
esac
```

Use the service's `Type=notify` result as the readiness result:

```bash
native_start_and_verify() {
  if ! systemctl enable --now "$DSH_SERVICE_NAME"; then
    systemctl status --no-pager --full "$DSH_SERVICE_NAME" >&2 || true
    journalctl -u "$DSH_SERVICE_NAME" -n 50 --no-pager >&2 || true
    return 1
  fi
  systemctl is-active --quiet "$DSH_SERVICE_NAME" || { dsh_die "$DSH_SERVICE_NAME did not remain active"; return 1; }
}

native_show_urls() {
  dsh_load_tailscale_identity
  echo "Web UI: https://$DSH_MAGICDNS/"
  echo "Local proxy: http://127.0.0.1:${DSH_PUBLIC_PORT:-4080}/"
}
```

`as_root` reinvokes `start.sh` with the original non-root identity in `DSH_SERVICE_USER`; it never forwards arbitrary environment variables. `uninstall` validates unit ownership, disables/stops it, removes only the owned unit and matching Serve route, reloads systemd, and preserves config/state for inspection.

- [ ] **Step 6: Run installer and lifecycle tests**

Use stub `sudo`, `runuser`, `systemctl`, `systemd-analyze`, `getent`, `id`, `stat`, `install`, and `tailscale` commands in `scripts/start.spec.ts`. Run:

```bash
pnpm exec vitest run scripts/start.spec.ts -t 'renders|configuration|installs|lifecycle|uninstall'
```

Expected: all selected tests PASS and the call log proves build precedes `systemctl enable --now`.

- [ ] **Step 7: Commit systemd installation**

```bash
git add start.sh scripts/deployment/native-service.sh scripts/start.spec.ts
git commit -m "feat(deploy): install native Harness service"
```

---

### Task 4: Add owned Docker migration and rollback

**Files:**
- Modify: `scripts/deployment/native-service.sh`
- Modify: `scripts/start.spec.ts`
- Modify: `run-docker.sh`

**Interfaces:**
- Produces: `native_detect_owned_docker REPO`, which prints exact container IDs one per line only after all ownership checks pass.
- Produces: `native_assert_expected_serve_target TARGET` and `native_wait_docker_proxy` for migration validation and rollback health.
- Extends: `native_command install` with the stop/start/rollback/remove transaction.
- Consumes: the shared deployment lock, canonical checkout, Compose labels, expected `dsh`/`auth-proxy` services, and live Tailscale target.

- [ ] **Step 1: Write failing migration ownership tests**

Add a table test for matching and nonmatching Compose labels:

```ts
it.each([
  ['matching checkout', '/repo', '/repo', 0],
  ['different checkout', '/repo', '/other', 1],
])('proves Docker ownership: %s', (_name, expectedRepo, labelRepo, expectedStatus) => {
  const result = runNativeFunction('native_detect_owned_docker', [expectedRepo], {
    DSH_TEST_DOCKER_LABEL_REPO: labelRepo,
  })
  expect(result.status).toBe(expectedStatus)
})
```

The fake Docker CLI must return two container IDs, `com.docker.compose.service` values `dsh` and `auth-proxy`, `com.docker.compose.project.working_dir`, the Compose config-file label, and current running state. Add refusal cases for one missing service, an extra project directory, wrong route target, and an unrelated listener.

- [ ] **Step 2: Write failing rollback ordering test**

Stub native readiness to fail after containers stop and assert exact order:

```ts
expect(calls).toEqual([
  'docker stop dsh-id auth-proxy-id',
  'systemctl enable --now deepseek-harness.service',
  'systemctl disable --now deepseek-harness.service',
  'docker start dsh-id auth-proxy-id',
  'probe http://127.0.0.1:4080/',
])
```

Also assert the native error and rollback result are both present in stderr and that container removal never occurs on failure.

- [ ] **Step 3: Run migration tests and verify RED**

```bash
pnpm exec vitest run scripts/start.spec.ts -t 'Docker ownership|rolls back Docker'
```

Expected: FAIL because migration functions are undefined.

- [ ] **Step 4: Implement exact ownership proof**

Use Docker inspect labels rather than container names alone:

```bash
native_detect_owned_docker() {
  local repo="$1" expected_compose="$1/docker/docker-compose.yml" ids id service working_dir config_files
  command -v docker >/dev/null 2>&1 || return 2
  mapfile -t ids < <(docker ps -q --filter label=com.docker.compose.project)
  local dsh_id="" proxy_id=""
  for id in "${ids[@]}"; do
    service="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$id")"
    working_dir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$id")"
    config_files="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "$id")"
    [ "$(readlink -f "$working_dir")" = "$repo" ] || continue
    [ "$config_files" = "$expected_compose" ] || continue
    case "$service" in dsh) dsh_id="$id" ;; auth-proxy) proxy_id="$id" ;; esac
  done
  [ -n "$dsh_id" ] && [ -n "$proxy_id" ] || return 2
  native_assert_expected_serve_target "http://127.0.0.1:$DSH_PUBLIC_PORT" || return 1
  printf '%s\n%s\n' "$dsh_id" "$proxy_id"
}
```

Treat return 2 as “no owned Docker deployment” and return 1 as an ambiguous/conflicting deployment. Require both exact services and reject duplicate matches. Parse Serve JSON and bound rollback readiness:

```bash
native_assert_expected_serve_target() {
  local expected="$1" actual
  actual="$(tailscale serve status --json | node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const j = JSON.parse(s)
  const web = j.Web && typeof j.Web === "object" ? Object.values(j.Web).flatMap(v => Object.values(v ?? {})) : []
  const target = web.find(v => typeof v === "object" && v !== null && "Proxy" in v)?.Proxy ?? ""
  process.stdout.write(String(target))
})')" || return 1
  [ "$actual" = "$expected" ] || { dsh_die "Tailscale Serve target is $actual, expected $expected"; return 1; }
}

native_wait_docker_proxy() {
  local attempt
  for ((attempt = 0; attempt < 30; attempt++)); do
    curl -fsS -o /dev/null "http://127.0.0.1:$DSH_PUBLIC_PORT/" && return 0
    sleep 1
  done
  dsh_die "restored Docker proxy did not become ready within 30 seconds"
}
```

- [ ] **Step 5: Implement stop, rollback, and finalize transaction**

Record IDs in a root-owned temporary state file under `/run/deepseek-harness-install/`. Stop exact IDs, start native, and branch on readiness:

```bash
local docker_output detection_status
local -a docker_ids=()
if docker_output="$(native_detect_owned_docker "$repo")"; then
  mapfile -t docker_ids <<<"$docker_output"
  docker stop "${docker_ids[@]}"
  if ! native_start_and_verify; then
    systemctl disable --now "$DSH_SERVICE_NAME" || true
    if docker start "${docker_ids[@]}" && native_wait_docker_proxy; then
      dsh_die "native service failed; restored Docker Harness"
      return 1
    fi
    dsh_die "native service failed and Docker rollback failed; inspect systemd and containers ${docker_ids[*]}"
    return 1
  fi
  docker rm "${docker_ids[@]}"
else
  detection_status=$?
  [ "$detection_status" -eq 2 ] || return "$detection_status"
  native_start_and_verify
fi
```

Write native deployment state atomically only after Docker removal and readiness succeed. Keep Docker named volumes. Update `run-docker.sh` to reject an active owned native unit before stopping or rebuilding Docker; print `./start.sh stop` or `./start.sh uninstall` as the corrective action.

- [ ] **Step 6: Run migration, rollback, and Docker regressions**

```bash
pnpm exec vitest run scripts/start.spec.ts -t 'Docker|migration|rollback'
pnpm exec vitest run scripts/run-docker.spec.ts
bash -n start.sh run-docker.sh scripts/deployment/common.sh scripts/deployment/native-service.sh
```

Expected: selected native tests PASS, 5 Docker tests PASS, Bash exits 0.

- [ ] **Step 7: Commit migration and rollback**

```bash
git add scripts/deployment/native-service.sh scripts/start.spec.ts run-docker.sh scripts/run-docker.spec.ts
git commit -m "feat(deploy): migrate Docker to native service"
```

---

### Task 5: Complete security failures and platform diagnostics

**Files:**
- Modify: `scripts/deployment/common.sh`
- Modify: `scripts/deployment/native-service.sh`
- Modify: `scripts/start.spec.ts`

**Interfaces:**
- Completes all failure behavior from the design specification.
- Preserves the public command and function names from Tasks 1–4.

- [ ] **Step 1: Add the invalid-state test matrix**

Create explicit cases with expected diagnostics:

```ts
it.each([
  ['root runtime', { DSH_SERVICE_USER: 'root' }, 'refusing to run Harness as root'],
  ['occupied operator', { TS_OPERATOR: 'other-user' }, 'Tailscale operator is already other-user'],
  ['occupied route', { TS_TARGET: 'http://127.0.0.1:9999' }, 'Tailscale Serve HTTPS port 443 is already owned'],
  ['symlink config', { CONFIG_KIND: 'symlink' }, 'must be a non-symlink regular file'],
  ['writable config', { CONFIG_MODE: '0666' }, 'must not be group- or world-writable'],
  ['unsupported shell', { LOGIN_SHELL: '/bin/nologin' }, 'cannot run non-interactive login commands'],
])('fails closed for %s', (_name, env, message) => {
  const result = runInstaller(env)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(message)
  expect(result.calls).not.toContain('systemctl enable --now deepseek-harness.service')
})
```

Add tests proving diagnostics redact a known `DSH_TASK_BOARD_PROXY_TOKEN` and that stop/uninstall refuse to remove a route whose live target changed after installation.

- [ ] **Step 2: Add Ubuntu, Fedora, and Arch dependency tests**

Stub `/etc/os-release` through a parameter accepted by `native_dependency_guidance` and assert exact commands:

```ts
expect(ubuntu.stderr).toContain('sudo apt install caddy tailscale')
expect(fedora.stderr).toContain('sudo dnf install caddy tailscale')
expect(arch.stderr).toContain('sudo pacman -S caddy tailscale')
for (const result of [ubuntu, fedora, arch]) {
  expect(result.stderr).toContain('Node.js ^22.19.0 or >=24.0.0')
  expect(result.stderr).toContain('pnpm 11.7.0')
  expect(result.calls).not.toMatch(/apt|dnf|pacman/)
}
```

Use the distributions' official Tailscale/Caddy repository guidance in prose; do not claim unavailable packages are in a base repository.

- [ ] **Step 3: Implement ownership, shell, and redaction checks**

Add `native_validate_external_file`, `native_check_operator`, `native_check_route_ownership`, and `native_validate_login_shell`. Capture child diagnostics through a redaction function before printing:

```bash
native_redact() {
  local text="$1" token="${DSH_TASK_BOARD_PROXY_TOKEN:-}"
  [ -z "$token" ] || text="${text//$token/[redacted]}"
  printf '%s\n' "$text"
}
```

Route cleanup must compare HTTPS port, protocol, and target from `tailscale serve status --json` with the state file before invoking `tailscale serve --https="$port" off`. Existing nonempty operators are accepted only when equal to the service user.

- [ ] **Step 4: Run all native launcher checks**

```bash
pnpm exec vitest run scripts/start.spec.ts
pnpm exec oxlint scripts/start.spec.ts scripts/run-docker.spec.ts
bash -n start.sh run-docker.sh scripts/deployment/common.sh scripts/deployment/native-service.sh
```

Expected: all native and Docker script tests PASS; Oxlint and Bash exit 0.

- [ ] **Step 5: Commit security and platform diagnostics**

```bash
git add scripts/deployment/common.sh scripts/deployment/native-service.sh scripts/start.spec.ts
git commit -m "fix(deploy): fail closed on native service conflicts"
```

---

### Task 6: Document native deployment and record the decision

**Files:**
- Create: `deployment/README.md`
- Create: `deployment/README.zh.md`
- Create: `deployment/README.i18n.yaml`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `README.i18n.yaml`
- Modify: `docker/README.md`
- Modify: `docker/README.zh.md`
- Modify: `docker/README.i18n.yaml`
- Create: `.agents/notes/implemented/feature/2026-08-24-native-deepseek-harness-service.md`
- Create: `.agents/notes/implemented/feature/2026-08-24-native-deepseek-harness-service.zh.md`
- Create: `.agents/notes/implemented/feature/2026-08-24-native-deepseek-harness-service.i18n.yaml`
- Archive through the Agent Note workflow: `.agents/notes/implemented/simplification/2026-08-22-remove-host-web-launcher.*`

**Interfaces:**
- Documents the exact commands, dependencies, permissions, configuration, migration, rollback, Tailscale behavior, and limitations implemented in Tasks 1–5.
- Records the direct-host requirement and why shared deployment policy makes the native alternative maintainable.

- [ ] **Step 1: Write the English native deployment reference**

Create `deployment/README.md` with these sections and executable examples:

```markdown
# Native DeepSeek Harness service

English | [中文](README.zh.md)

`start.sh` installs this checkout as `deepseek-harness.service`. Harness and Caddy run as the installing non-root user; Tailscale Serve publishes the loopback proxy.

## Prerequisites

List systemd, connected Tailscale, Caddy 2, Node.js `^22.19.0 || >=24.0.0`, pnpm `11.7.0`, Git, and curl, followed by Ubuntu, Fedora, and Arch commands.

## Install or update

```sh
./start.sh
```

Explain build-before-cutover, exact Docker migration ownership, rollback, login-environment access, and host-root-equivalent Docker-group consequences.

## Operations

Show `start`, `stop`, `restart`, `status`, `logs`, and `uninstall`.

## Configuration

Document `/etc/deepseek-harness.env`, defaults, validation, and restart after edits.

## Tailscale authorization

Explain tailnet ACL access, owner-only routes, loopback binding, operator refusal, and route ownership.

## Limitations

State systemd-only Ubuntu/Fedora/Arch support, host-node-only Tailscale, no concurrent Docker deployment, no package installation, and preserved configuration on uninstall.
```

Write the Chinese counterpart in the same pass with matching headings and facts.

- [ ] **Step 2: Update root and Docker deployment choices**

Add a root README native section before Docker:

```markdown
### Install the Web UI as a native service (`start.sh`)

For unrestricted access to the host user's tools and files, [start.sh](start.sh) installs a reboot-persistent non-root systemd service behind the same Tailscale identity proxy. See [deployment/README.md](deployment/README.md).
```

In Docker documentation, state that `start.sh` is the direct-host alternative and that ownership checks prevent both launchers from using the same ports/routes concurrently. Apply the equivalent Chinese changes.

- [ ] **Step 3: Write the implemented Agent Note and archive the superseded decision**

Invoke the `dsh-archive-agent-notes` skill. The new note must cover:

```text
Problem: explicit container mounts still omit login-shell tools, host services, credentials, and devices, causing agents to report capabilities such as Docker as absent.
Decision: one non-root native systemd service supervises Harness and Caddy; native and Docker launchers share policy; migration proves ownership and rolls back exact containers.
Alternatives: Docker-only explicit mounts; restored standalone launcher duplication; multiple systemd units; published npm package.
Consequences: direct user permissions and supplementary groups, host-root-equivalent authority when the user belongs to docker, systemd-only platform scope, and a three-distribution validation obligation.
Verification: name the focused launcher tests and manual smoke evidence actually completed.
```

Archive the active removal note as superseded rather than rewriting its historical decision. Update inbound links or the archive manifest exactly as the archive skill requires.

- [ ] **Step 4: Record bilingual pairings and run documentation checks**

```bash
pnpm run verify-translation-pairing --write deployment/README.md
pnpm run verify-translation-pairing --write README.md
pnpm run verify-translation-pairing --write docker/README.md
pnpm run verify-translation-pairing --write .agents/notes/implemented/feature/2026-08-24-native-deepseek-harness-service.md
pnpm run doc-sync
git diff --check
```

Expected: translation records are written; all documentation gates PASS; `git diff --check` emits no output.

- [ ] **Step 5: Commit documentation and decision records**

```bash
git add -- deployment/README.md deployment/README.zh.md deployment/README.i18n.yaml README.md README.zh.md README.i18n.yaml docker/README.md docker/README.zh.md docker/README.i18n.yaml \
  .agents/notes/implemented/feature/2026-08-24-native-deepseek-harness-service.md \
  .agents/notes/implemented/feature/2026-08-24-native-deepseek-harness-service.zh.md \
  .agents/notes/implemented/feature/2026-08-24-native-deepseek-harness-service.i18n.yaml \
  .agents/notes/implemented/simplification/2026-08-22-remove-host-web-launcher.md \
  .agents/notes/implemented/simplification/2026-08-22-remove-host-web-launcher.zh.md \
  .agents/notes/implemented/simplification/2026-08-22-remove-host-web-launcher.i18n.yaml \
  .agents/notes/archived/simplification/2026-08-22-remove-host-web-launcher.md \
  .agents/notes/archived/simplification/2026-08-22-remove-host-web-launcher.zh.md \
  .agents/notes/archived/simplification/2026-08-22-remove-host-web-launcher.i18n.yaml \
  .agents/notes/archived/manifest.json
git commit -m "docs: document native Harness deployment"
```

---

### Task 7: Run final focused verification and platform smokes

**Files:**
- Modify only files required by failures found in this task.
- Record manual platform evidence in the new Agent Note before its final commit if the evidence was unavailable during Task 6.

**Interfaces:**
- Verifies the complete feature without widening scope to the full repository suite.

- [ ] **Step 1: Run the assembled launcher suites**

```bash
pnpm exec vitest run scripts/start.spec.ts scripts/run-docker.spec.ts
pnpm exec oxlint scripts/start.spec.ts scripts/run-docker.spec.ts
bash -n start.sh run-docker.sh scripts/deployment/common.sh scripts/deployment/native-service.sh
pnpm run doc-sync
git diff --check
```

Expected: all focused tests PASS, lint and Bash exit 0, all documentation checks PASS, and whitespace check emits no output.

- [ ] **Step 2: Run an Ubuntu native smoke**

On a current Ubuntu system with Tailscale and Caddy configured:

```bash
./start.sh
./start.sh status
curl -fsS https://"$(tailscale status --json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).Self.DNSName.replace(/\.$/,"")')"/
sudo systemctl restart deepseek-harness.service
./start.sh uninstall
```

Expected: install reports the native URL, status is active, HTTPS returns the Web UI, restart returns to active, and uninstall removes the unit while preserving `/etc/deepseek-harness.env`.

- [ ] **Step 3: Repeat the native smoke on Fedora and Arch**

Run the same commands on current Fedora and Arch systems. Record distribution, systemd, Tailscale, Caddy, Node, pnpm, and login-shell versions in the Agent Note. Do not claim support for a platform whose install, reboot restart, update, and uninstall paths were not exercised.

- [ ] **Step 4: Exercise Docker migration and rollback on one supported host**

Start the owned Docker deployment, run `./start.sh`, and verify the Docker containers are removed only after native readiness. Repeat with a controlled failing Caddy command and verify the exact original container IDs return healthy and the native unit is disabled.

- [ ] **Step 5: Close verification without an empty commit**

If a verification command fails, return to the task that owns the failing behavior, add a regression assertion there, apply the correction, rerun that task's focused checks, and use that task's exact `git add` command with commit message `fix(deploy): resolve native service verification finding`. If every command passes without a correction, do not create an empty commit.

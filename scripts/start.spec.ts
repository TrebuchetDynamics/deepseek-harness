import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '..')
const launcher = join(repository, 'start.sh')

interface RuntimeFixture {
  bin: string
  calls: string
  config: string
  loginShell: string
  root: string
  runtime: string
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`)
  chmodSync(path, 0o755)
}

function createRuntimeFixture(): RuntimeFixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-runtime-'))
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.log')
  const config = join(root, 'service.env')
  const runtime = join(root, 'run')
  mkdirSync(bin)
  mkdirSync(runtime)
  writeFileSync(
    config,
    'DSH_BACKEND_PORT=4081\nDSH_PUBLIC_PORT=4080\nDSH_HTTPS_PORT=443\nDSH_STARTUP_TIMEOUT=3\nTAILSCALE_OWNER=owner@example.test\nDSH_EXTRA_TRUSTED_HOSTS=\n',
  )
  executable(
    join(bin, 'pnpm'),
    'printf "backend start\\n" >> "$CALLS"\nprintf "dsh web: http://127.0.0.1:4081/?token=fixture-token\\n"\ntrap \'printf "backend TERM\\n" >> "$CALLS"; exit 0\' TERM INT\nwhile :; do sleep 1; done',
  )
  executable(
    join(bin, 'caddy'),
    'printf "caddy start token=%s provider=%s bind=%s\\n" "${DSH_BROWSER_LAUNCH_TOKEN:-missing}" "${DSH_VPN_PROVIDER:-missing}" "${DSH_BIND_ADDRESS:-missing}" >> "$CALLS"\n[ -z "${NOTIFY_SOCKET:-}" ] || printf "caddy inherited notify\\n" >> "$CALLS"\n[ "${CADDY_EXIT:-0}" = 0 ] || exit 7\ntrap \'printf "caddy TERM\\n" >> "$CALLS"; exit 0\' TERM INT\nwhile :; do sleep 1; done',
  )
  executable(
    join(bin, 'tailscale'),
    `case "$*" in
  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"host.tail.test.","UserID":1},"User":{"1":{"LoginName":"owner@example.test"}}}' ;;
  "ip -4") echo 100.64.0.1 ;;
  *) printf "tailscale %s\\n" "$*" >> "$CALLS" ;;
esac`,
  )
  executable(join(bin, 'netbird'), 'case "$*" in "status --ipv4") [ "${NETBIRD_CONNECTED:-0}" = 1 ] || exit 1; echo 100.64.0.2 ;; *) printf "netbird %s\\n" "$*" >> "$CALLS" ;; esac')
  executable(
    join(bin, 'curl'),
    `case "$*" in
  *'?token=fixture-token'*)
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -c ]; then shift; printf 'fixture-cookie\n' > "$1"; fi
      shift
    done
    printf 303
    ;;
  *__dsh_api_namespace_probe__*unauthorized@example.invalid*) printf '%s' "\${SCOPE_DENIED_STATUS:-403}" ;;
  *__dsh_api_namespace_probe__*owner@example.test*) printf '%s' "\${SCOPE_OWNER_STATUS:-404}" ;;
  *unauthorized@example.invalid*) printf 403 ;;
  *owner@example.test*)
    if [ "\${OWNER_404_ONCE:-0}" = 1 ] && [ ! -e "$CALLS.owner-404" ]; then
      : > "$CALLS.owner-404"
      printf 404
    else
      printf '%s' "\${OWNER_STATUS:-200}"
    fi
    ;;
  *127.0.0.1*)
    if [[ "$*" == *-f* ]] && [ "\${ROOT_STATUS:-200}" -ge 400 ]; then exit 22; fi
    ;;
  *) exit 0 ;;
esac`,
  )
  executable(
    join(bin, 'systemd-notify'),
    'printf "notify %s\\n" "$*" >> "$CALLS"',
  )
  executable(join(bin, 'stat'), 'printf "%s\\n" "${STAT_OUTPUT:-0 644}"')
  const loginShell = join(bin, 'login-shell')
  executable(
    loginShell,
    '[ "$1" = -lc ]\n[ -z "${LOGIN_PATH:-}" ] || export PATH="$LOGIN_PATH"\nexec /bin/bash -c "$2"',
  )
  return { bin, calls, config, loginShell, root, runtime }
}

function spawnRuntime(
  fixture: RuntimeFixture,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcess {
  return spawn(
    launcher,
    [
      '__service',
      fixture.config,
      repository,
      process.env.USER ?? 'node',
      fixture.root,
      fixture.loginShell,
    ],
    {
      cwd: repository,
      env: {
        ...process.env,
        CALLS: fixture.calls,
        NOTIFY_SOCKET: join(fixture.root, 'notify.sock'),
        PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
        RUNTIME_DIRECTORY: fixture.runtime,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
}

async function waitForLog(path: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    let content = ''
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      // The child creates the call log after its first observable operation.
    }
    if (content.includes(expected)) return
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
  }
  throw new Error(`timed out waiting for ${JSON.stringify(expected)}`)
}

async function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; stderr: string }> {
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk
  })
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', resolveExit)
  })
  return { code, stderr }
}

interface InstallFixture {
  bin: string
  calls: string
  home: string
  loginShell: string
  root: string
  systemRoot: string
}

function createInstallFixture(): InstallFixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-install-'))
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.log')
  const home = join(root, 'home')
  const systemRoot = join(root, 'system-root')
  const loginShell = join(bin, 'login-shell')
  mkdirSync(bin)
  mkdirSync(home)
  mkdirSync(join(systemRoot, 'etc'), { recursive: true })
  writeFileSync(join(systemRoot, 'etc/os-release'), 'ID=ubuntu\n')
  writeFileSync(calls, '')
  executable(
    join(bin, 'id'),
    `case "$*" in
  "-u node") echo ${process.getuid?.() ?? 1000} ;;
  "-u") echo 0 ;;
  "-un") echo root ;;
  "-gn node") echo node ;;
  "node") exit 0 ;;
  *) /usr/bin/id "$@" ;;
esac`,
  )
  executable(
    join(bin, 'getent'),
    'printf "node:x:1000:1000::%s:%s\\n" "$SERVICE_HOME" "$LOGIN_SHELL"',
  )
  executable(
    join(bin, 'runuser'),
    'while [ "$1" != -- ]; do shift; done\nshift\nexec "$@"',
  )
  executable(
    loginShell,
    '[ "$1" = -lc ]\n[ -z "${LOGIN_PATH:-}" ] || export PATH="$LOGIN_PATH"\nif [ -n "${HIDE_CADDY_UNTIL:-}" ]; then command() { if [ "${1:-}" = -v ] && [ "${2:-}" = caddy ] && [ ! -x "$HIDE_CADDY_UNTIL" ]; then return 1; fi; builtin command "$@"; }; export -f command; fi\nexec /bin/bash -c "$2"',
  )
  executable(
    join(bin, 'pnpm'),
    '[ -z "${PNPM_EXPECT_NODE:-}" ] || [ "$(command -v node)" = "$PNPM_EXPECT_NODE" ] || { printf "wrong pnpm Node: %s\\n" "$(command -v node)" >&2; exit 92; }\nif [ "$*" = --version ]; then echo 11.7.0; else printf "pnpm %s\\n" "$*" >> "$CALLS"; printf "pnpm verbose output: %s\\n" "$*"; fi\ncase "${PNPM_FAILURE:-}:$*" in build:*" run build") exit 9 ;; esac',
  )
  executable(join(bin, 'caddy'), '[ "${1:-}" = version ] && echo v2.10.0 || :')
  executable(join(bin, 'chown'), ':')
  executable(
    join(bin, 'tailscale'),
    `case "$*" in
  "status --json") echo '{"BackendState":"Running","Self":{"DNSName":"host.tail.test.","UserID":1},"User":{"1":{"LoginName":"owner@example.test"}}}' ;;
  "ip -4") [ "\${TAILSCALE_CONNECTED:-1}" = 1 ] || exit 1; echo 100.64.0.1 ;;
  "debug prefs") printf '{"OperatorUser":"%s"}\\n' "\${TS_OPERATOR:-node}" ;;
  "serve status --json")
    target="\${TS_TARGET:-http://127.0.0.1:4080}"
    [ ! -e "$CALLS.serve-off-raced" ] || target=
    printf '{"Web":{"host.tail.test:443":{"Handlers":{"/":{"Proxy":"%s"}}}}}\n' "$target"
    ;;
  "serve --yes --bg --https=443 off")
    if [ "\${SERVE_OFF_RACE:-0}" = 1 ]; then : > "$CALLS.serve-off-raced"; echo 'Tailscale is stopped.'; exit 1; fi
    [ "\${FAIL_SERVE_OFF:-0}" != 1 ] || exit 1
    printf "tailscale %s\n" "$*" >> "$CALLS"
    ;;
  *) printf "tailscale %s\n" "$*" >> "$CALLS" ;;
esac`,
  )
  executable(
    join(bin, 'netbird'),
    `case "$*" in
  "status --ipv4") [ "\${NETBIRD_CONNECTED:-0}" = 1 ] || exit 1; echo 100.64.0.2 ;;
  *) printf "netbird %s\\n" "$*" >> "$CALLS" ;;
esac`,
  )
  executable(
    join(bin, 'docker'),
    `case "$*" in
  "ps -q --filter label=com.docker.compose.project")
    [ "\${OWNED_DOCKER:-0}" = 1 ] && printf 'dsh-id\\nauth-proxy-id\\n'
    ;;
  *com.docker.compose.service*)
    [ "$4" = dsh-id ] && printf dsh || printf auth-proxy
    ;;
  *com.docker.compose.project.working_dir*) printf '%s' "\${DOCKER_REPO:-$REPOSITORY}" ;;
  *com.docker.compose.project.config_files*) printf '%s' "$REPOSITORY/docker/docker-compose.yml" ;;
  rm*) printf "docker %s\\n" "$*" >> "$CALLS" ;;
esac`,
  )
  executable(
    join(bin, 'install'),
    `printf "install %s\\n" "$*" >> "$CALLS"
if [ "$1" = -d ]; then
  destination="\${@: -1}"
  mkdir -p "$destination"
  candidate="\${@: -2:1}"
  case "$candidate" in /*) mkdir -p "$candidate" ;; esac
else
  source_file="\${@: -2:1}"
  destination="\${@: -1}"
  mkdir -p "$(dirname "$destination")"
  cp "$source_file" "$destination"
fi`,
  )
  executable(
    join(bin, 'systemd-analyze'),
    'printf "systemd-analyze %s\\n" "$*" >> "$CALLS"',
  )
  executable(
    join(bin, 'systemctl'),
    'printf "systemctl %s\\n" "$*" >> "$CALLS"\ncase "$*" in "cat caddy.service") [ "${CADDY_UNIT_PRESENT:-0}" = 1 ] || [ -x "${PACKAGE_CADDY_TARGET:-/nonexistent}" ] || exit 1 ;; status*) [ -z "${LEAK_TEXT:-}" ] || printf "%s\\n" "$LEAK_TEXT" >&2 ;; esac\nif [ "${FAIL_CADDY_DISABLE:-0}" = 1 ] && [ "$*" = "disable --now caddy.service" ]; then exit 8; fi\nif [ "${FAIL_NATIVE:-0}" = 1 ] && [ "$*" = "enable --now deepseek-harness.service" ]; then exit 1; fi\nif [ "$*" = "enable --now deepseek-harness.service" ]; then mkdir -p "$DSH_SERVICE_RUNTIME_DIR"; printf "http://127.0.0.1:4081/?token=fixture-token\\n" > "$DSH_SERVICE_RUNTIME_DIR/backend-url"; fi',
  )
  executable(
    join(bin, 'journalctl'),
    'printf "journalctl %s\\n" "$*" >> "$CALLS"\n[ -z "${LEAK_TEXT:-}" ] || printf "%s\\n" "$LEAK_TEXT" >&2',
  )
  executable(join(bin, 'curl'), ':')
  executable(
    join(bin, 'ss'),
    '[ -z "${OCCUPIED_PORT:-}" ] || printf "LISTEN 0 128 127.0.0.1:%s 0.0.0.0:*\\n" "$OCCUPIED_PORT"',
  )
  executable(join(bin, 'stat'), 'printf "%s\\n" "${STAT_OUTPUT:-0 644}"')
  return { bin, calls, home, loginShell, root, systemRoot }
}

function runLifecycle(
  fixture: InstallFixture,
  command: string | undefined,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(launcher, command === undefined ? [] : [command], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      CALLS: fixture.calls,
      DSH_SERVICE_USER: 'node',
      DSH_DEPLOYMENT_LOCK_HELD: '1',
      DSH_SYSTEM_ROOT: fixture.systemRoot,
      DSH_SERVICE_RUNTIME_DIR: join(fixture.root, 'service-run'),
      HIDE_CADDY_UNTIL: join(fixture.bin, 'caddy'),
      LOGIN_SHELL: fixture.loginShell,
      PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
      REPOSITORY: repository,
      SERVICE_HOME: fixture.home,
      ...extraEnv,
    },
  })
}

function runInstaller(
  fixture: InstallFixture,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return runLifecycle(fixture, 'install', extraEnv)
}

describe('deployment command progress', () => {
  it.runIf(process.platform === 'linux')(
    'terminates command process groups in concise and verbose modes',
    async () => {
      for (const verbose of ['', '1']) {
        const root = mkdtempSync(join(tmpdir(), 'dsh-deployment-step-'))
        const calls = join(root, 'calls.log')
        const command = join(root, 'long-step')
        const grandchild = join(root, 'grandchild.pid')
        executable(
          command,
          'trap \'printf "child TERM\\n" >> "$CALLS"; exit 0\' TERM\nsleep 30 &\nprintf "%s\\n" "$!" > "$GRANDCHILD"\nprintf "child ready\\n" >> "$CALLS"\nwait',
        )
        const child = spawn(
          '/bin/bash',
          ['-c', 'source "$COMMON"; dsh_run_step "Long step" "$COMMAND"'],
          {
            env: {
              ...process.env,
              CALLS: calls,
              COMMAND: command,
              COMMON: join(repository, 'scripts/deployment/common.sh'),
              DSH_VERBOSE: verbose,
              GRANDCHILD: grandchild,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        try {
          await waitForLog(calls, 'child ready')
          const exited = waitForExit(child)
          child.kill('SIGTERM')
          await expect(exited).resolves.toMatchObject({ code: 143 })
          await waitForLog(calls, 'child TERM')
          const grandchildPid = Number(readFileSync(grandchild, 'utf8'))
          let running = true
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              process.kill(grandchildPid, 0)
            } catch {
              running = false
              break
            }
            await new Promise(resolveWait => setTimeout(resolveWait, 10))
          }
          expect(
            running,
            `verbose=${verbose || '0'} left grandchild ${grandchildPid}`,
          ).toBe(false)
        } finally {
          if (child.exitCode === null) child.kill('SIGKILL')
        }
      }
    },
  )
})

describe('native Harness service installation', () => {
  it.runIf(process.platform === 'linux')(
    'delegates status to systemd and reports installed URLs',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      writeFileSync(fixture.calls, '')

      const result = runLifecycle(fixture, 'status')

      expect(result.status).toBe(0)
      expect(readFileSync(fixture.calls, 'utf8')).toContain(
        'systemctl status --no-pager --full deepseek-harness.service',
      )
      expect(result.stdout).toContain('Web UI: https://host.tail.test/')
      expect(result.stdout).not.toContain('token=')
      expect(result.stdout).toContain('Local proxy: http://127.0.0.1:4080/')
    },
  )

  it.runIf(process.platform === 'linux')(
    'recovers an installation whose recorded checkout no longer exists',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      const statePath = join(
        fixture.systemRoot,
        'var/lib/deepseek-harness/deployment.json',
      )
      const missingCheckout = join(
        fixture.root,
        'missing-parent',
        'missing-checkout',
      )
      writeFileSync(
        statePath,
        readFileSync(statePath, 'utf8').replace(repository, missingCheckout),
      )

      const staleStatus = runLifecycle(fixture, 'status')
      expect(staleStatus.status).not.toBe(0)
      expect(staleStatus.stderr).toContain(
        `installed service checkout no longer exists: ${missingCheckout}; run './start.sh install' from the desired checkout to recover`,
      )

      writeFileSync(fixture.calls, '')
      const recovered = runInstaller(fixture)
      expect(recovered.status, recovered.stderr).toBe(0)
      expect(readFileSync(statePath, 'utf8')).toContain(
        `"checkout": "${repository}"`,
      )
      const calls = readFileSync(fixture.calls, 'utf8').trim().split('\n')
      expect(calls.findIndex(line => line.endsWith('run build'))).toBeLessThan(
        calls.indexOf('systemctl stop deepseek-harness.service'),
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'installs by default when invoked without a command',
    () => {
      const fixture = createInstallFixture()
      const result = runLifecycle(fixture, undefined)
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(fixture.calls, 'utf8')).toContain(
        'systemctl enable --now deepseek-harness.service',
      )
      expect(result.stdout).toContain('Web UI: https://host.tail.test/')
      expect(result.stdout).not.toContain('?token=fixture-token')
      expect(result.stdout).toContain(
        'Installed persistent deepseek-harness.service; it continues in the background.',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'prefers a connected NetBird when no provider is configured',
    () => {
      const fixture = createInstallFixture()

      const result = runLifecycle(fixture, undefined, {
        NETBIRD_CONNECTED: '1',
      })

      expect(result.status, result.stderr).toBe(0)
      expect(
        readFileSync(
          join(fixture.systemRoot, 'etc/deepseek-harness.env'),
          'utf8',
        ),
      ).toContain('DSH_VPN_PROVIDER=netbird')
    },
  )

  it.runIf(process.platform === 'linux')(
    'requires an explicit provider when no VPN is connected',
    () => {
      const fixture = createInstallFixture()

      const result = runLifecycle(fixture, undefined, {
        TAILSCALE_CONNECTED: '0',
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'no connected NetBird or Tailscale network found',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'installs missing Ubuntu host packages before checking versions',
    () => {
      const fixture = createInstallFixture()
      const caddy = join(fixture.bin, 'caddy')
      const packagedCaddy = join(fixture.bin, 'packaged-caddy')
      unlinkSync(caddy)
      executable(packagedCaddy, '[ "${1:-}" = version ] && echo v2.10.0 || :')
      executable(
        join(fixture.bin, 'apt-get'),
        'printf "apt-get %s\\n" "$*" >> "$CALLS"\ncase "$1" in install) cp "$PACKAGE_CADDY_SOURCE" "$PACKAGE_CADDY_TARGET" ;; esac',
      )

      const result = runInstaller(fixture, {
        PACKAGE_CADDY_SOURCE: packagedCaddy,
        PACKAGE_CADDY_TARGET: caddy,
      })

      expect(result.status, result.stderr).toBe(0)
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).toContain('apt-get update')
      expect(calls).toContain(
        'apt-get install -y --no-install-recommends caddy',
      )
      expect(calls).toContain('systemctl disable --now caddy.service')
    },
  )

  it.runIf(process.platform === 'linux')(
    'preserves an existing Caddy service when its binary is outside the login PATH',
    () => {
      const fixture = createInstallFixture()
      unlinkSync(join(fixture.bin, 'caddy'))

      const result = runInstaller(fixture, { CADDY_UNIT_PRESENT: '1' })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'refusing to replace an existing host service',
      )
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain(
        'systemctl stop deepseek-harness.service',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'rejects root-direct installation before package mutation',
    () => {
      const fixture = createInstallFixture()
      unlinkSync(join(fixture.bin, 'caddy'))
      executable(
        join(fixture.bin, 'apt-get'),
        'printf "apt-get %s\\n" "$*" >> "$CALLS"',
      )

      const result = runInstaller(fixture, { DSH_DEPLOYMENT_LOCK_HELD: '' })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'must be invoked as the non-root service user',
      )
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain('apt-get')
    },
  )

  it.runIf(process.platform === 'linux')(
    'cleans up a partially installed Caddy service so retry succeeds',
    () => {
      const fixture = createInstallFixture()
      const caddy = join(fixture.bin, 'caddy')
      const packagedCaddy = join(fixture.bin, 'packaged-caddy')
      const failureMarker = join(fixture.root, 'package-failed')
      unlinkSync(caddy)
      executable(packagedCaddy, '[ "${1:-}" = version ] && echo v2.10.0 || :')
      executable(
        join(fixture.bin, 'apt-get'),
        'printf "apt-get %s\\n" "$*" >> "$CALLS"\ncase "$1" in install) cp "$PACKAGE_CADDY_SOURCE" "$PACKAGE_CADDY_TARGET"; [ -e "$PACKAGE_FAILURE_MARKER" ] || { touch "$PACKAGE_FAILURE_MARKER"; exit 9; } ;; esac',
      )
      const environment = {
        PACKAGE_CADDY_SOURCE: packagedCaddy,
        PACKAGE_CADDY_TARGET: caddy,
        PACKAGE_FAILURE_MARKER: failureMarker,
      }

      const failed = runInstaller(fixture, environment)
      expect(failed.status).not.toBe(0)
      let calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).toContain('systemctl disable --now caddy.service')
      expect(calls).toContain('systemctl unmask caddy.service')

      writeFileSync(fixture.calls, '')
      const retried = runInstaller(fixture, environment)
      expect(retried.status, retried.stderr).toBe(0)
      calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).not.toContain('apt-get install')
    },
  )

  it.runIf(process.platform === 'linux')(
    'keeps the Caddy safety mask when package-service disable fails',
    () => {
      const fixture = createInstallFixture()
      const caddy = join(fixture.bin, 'caddy')
      const packagedCaddy = join(fixture.bin, 'packaged-caddy')
      unlinkSync(caddy)
      executable(packagedCaddy, '[ "${1:-}" = version ] && echo v2.10.0 || :')
      executable(
        join(fixture.bin, 'apt-get'),
        'case "$1" in install) cp "$PACKAGE_CADDY_SOURCE" "$PACKAGE_CADDY_TARGET" ;; esac',
      )

      const result = runInstaller(fixture, {
        FAIL_CADDY_DISABLE: '1',
        PACKAGE_CADDY_SOURCE: packagedCaddy,
        PACKAGE_CADDY_TARGET: caddy,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('safety mask was restored')
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).toContain('systemctl mask caddy.service')
      expect(calls).toContain('systemctl unmask caddy.service')
      expect(
        readFileSync(
          join(
            fixture.systemRoot,
            'var/lib/deepseek-harness/caddy-package-installing',
          ),
          'utf8',
        ),
      ).toBe('')
    },
  )

  it.runIf(process.platform === 'linux')(
    'installs missing Fedora host packages before checking versions',
    () => {
      const fixture = createInstallFixture()
      const caddy = join(fixture.bin, 'caddy')
      const packagedCaddy = join(fixture.bin, 'packaged-caddy')
      writeFileSync(join(fixture.systemRoot, 'etc/os-release'), 'ID=fedora\n')
      unlinkSync(caddy)
      executable(packagedCaddy, '[ "${1:-}" = version ] && echo v2.10.0 || :')
      executable(
        join(fixture.bin, 'dnf'),
        'printf "dnf %s\\n" "$*" >> "$CALLS"\ncp "$PACKAGE_CADDY_SOURCE" "$PACKAGE_CADDY_TARGET"',
      )

      const result = runInstaller(fixture, {
        PACKAGE_CADDY_SOURCE: packagedCaddy,
        PACKAGE_CADDY_TARGET: caddy,
      })

      expect(result.status, result.stderr).toBe(0)
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).toContain('dnf install -y caddy')
      expect(calls).toContain('systemctl disable --now caddy.service')
    },
  )

  it.runIf(process.platform === 'linux')(
    'activates the pinned pnpm through Corepack when pnpm is missing',
    () => {
      const fixture = createInstallFixture()
      const pnpm = join(fixture.bin, 'pnpm')
      const packagedPnpm = join(fixture.bin, 'packaged-pnpm')
      renameSync(pnpm, packagedPnpm)
      executable(join(fixture.bin, 'node'), 'exec "$REAL_NODE" "$@"')
      executable(
        join(fixture.bin, 'corepack'),
        'printf "corepack %s\n" "$*" >> "$CALLS"\ncase "$*" in "prepare pnpm@11.7.0 --activate") : ;; "enable pnpm") cp "$COREPACK_PNPM_SOURCE" "$COREPACK_PNPM_TARGET" ;; *) exit 1 ;; esac',
      )

      const result = runInstaller(fixture, {
        COREPACK_PNPM_SOURCE: packagedPnpm,
        COREPACK_PNPM_TARGET: pnpm,
        LOGIN_PATH: `${fixture.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        REAL_NODE: process.execPath,
      })

      expect(result.status, result.stderr).toBe(0)
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).toContain('corepack prepare pnpm@11.7.0 --activate')
      expect(calls).toContain('corepack enable pnpm')
    },
  )

  it.runIf(process.platform === 'linux')(
    'uses login-shell Node when the root PATH Node is unusable',
    () => {
      const fixture = createInstallFixture()
      const rootBin = join(fixture.root, 'root-bin')
      mkdirSync(rootBin)
      executable(join(rootBin, 'node'), 'exit 91')

      const result = runInstaller(fixture, {
        LOGIN_PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
        PATH: `${rootBin}:${fixture.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        PNPM_EXPECT_NODE: process.execPath,
      })

      expect(result.status, result.stderr).toBe(0)
      const unit = readFileSync(
        join(fixture.systemRoot, 'etc/systemd/system/deepseek-harness.service'),
        'utf8',
      )
      expect(unit).toContain(
        `Environment="DSH_PNPM_BIN=${join(fixture.bin, 'pnpm')}"`,
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'streams checkout command output in verbose mode',
    () => {
      const fixture = createInstallFixture()

      const result = runInstaller(fixture, { DSH_VERBOSE: '1' })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('pnpm verbose output')
    },
  )

  it.runIf(process.platform === 'linux')(
    'preserves the caller toolchain PATH while preparing the checkout',
    () => {
      const fixture = createInstallFixture()
      const userBin = join(fixture.root, 'user-bin')
      mkdirSync(userBin)
      executable(
        join(userBin, 'pnpm'),
        'if [ "$*" = --version ]; then echo 11.7.0; else printf "pnpm %s\\n" "$*" >> "$CALLS"; fi',
      )
      executable(join(fixture.bin, 'pnpm'), 'exit 91')

      const result = runInstaller(fixture, {
        DSH_CALLER_PATH: `${userBin}:${fixture.bin}:${process.env.PATH ?? ''}`,
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(fixture.calls, 'utf8')).toContain('pnpm --dir')
    },
  )

  it.runIf(process.platform === 'linux')(
    'builds before enabling an installed native service',
    () => {
      const fixture = createInstallFixture()
      const result = runInstaller(fixture)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).not.toContain('pnpm verbose output')
      expect(result.stdout).toContain('Building checkout artifacts done (')
      const log = readFileSync(fixture.calls, 'utf8').trim().split('\n')
      const installDependencies = log.findIndex(
        line =>
          line.includes('pnpm --dir') &&
          line.endsWith('install --frozen-lockfile'),
      )
      const build = log.findIndex(line => line.endsWith('run build'))
      const enable = log.findIndex(
        line => line === 'systemctl enable --now deepseek-harness.service',
      )
      expect(installDependencies).toBeGreaterThan(-1)
      expect(installDependencies).toBeLessThan(build)
      expect(build).toBeLessThan(enable)
      expect(
        readFileSync(
          join(
            fixture.systemRoot,
            'etc/systemd/system/deepseek-harness.service',
          ),
          'utf8',
        ),
      ).toContain('User=node')
      expect(
        readFileSync(
          join(
            fixture.systemRoot,
            'etc/systemd/system/deepseek-harness.service',
          ),
          'utf8',
        ),
      ).toContain(
        `ExecStart="${fixture.systemRoot}/usr/local/libexec/deepseek-harness/start.sh" __service`,
      )
      const installedCaddy = readFileSync(
        join(
          fixture.systemRoot,
          'usr/local/libexec/deepseek-harness/deployment/Caddyfile',
        ),
        'utf8',
      )
      expect(installedCaddy).toContain('@owner_api')
      expect(installedCaddy).toContain('path /api /api/*')
      expect(installedCaddy).toContain('not header_regexp Cookie dsh-auth-')
      expect(
        readFileSync(
          join(fixture.systemRoot, 'etc/deepseek-harness.env'),
          'utf8',
        ),
      ).toContain('TAILSCALE_OWNER=owner@example.test')
      const state: unknown = JSON.parse(
        readFileSync(
          join(fixture.systemRoot, 'var/lib/deepseek-harness/deployment.json'),
          'utf8',
        ),
      )
      expect(state).toEqual({
        checkout: repository,
        httpsPort: 443,
        provider: 'tailscale',
        publicTarget: 'http://127.0.0.1:4080',
        serviceUser: 'node',
      })
    },
  )

  it.runIf(process.platform === 'linux')(
    'installs a NetBird-bound service without Tailscale Serve',
    () => {
      const fixture = createInstallFixture()
      const result = runInstaller(fixture, {
        DSH_VPN_PROVIDER: 'netbird',
        NETBIRD_CONNECTED: '1',
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('Web UI: http://100.64.0.2:4080/')
      expect(result.stdout).not.toContain('Local proxy:')
      const repeat = runInstaller(fixture, { NETBIRD_CONNECTED: '1' })
      expect(repeat.status, repeat.stderr).toBe(0)
      const unit = readFileSync(
        join(fixture.systemRoot, 'etc/systemd/system/deepseek-harness.service'),
        'utf8',
      )
      expect(unit).not.toContain('tailscaled.service')
      expect(readFileSync(join(fixture.systemRoot, 'etc/deepseek-harness.env'), 'utf8'))
        .toContain('DSH_VPN_PROVIDER=netbird')
      const caddy = readFileSync(
        join(fixture.systemRoot, 'usr/local/libexec/deepseek-harness/deployment/Caddyfile'),
        'utf8',
      )
      expect(caddy).toContain('expression `{env.DSH_VPN_PROVIDER} == "netbird"`')
      expect(caddy).toContain('@owner_task_board {\n\t\texpression `{env.DSH_VPN_PROVIDER} == "tailscale"`')
      const state: unknown = JSON.parse(readFileSync(
        join(fixture.systemRoot, 'var/lib/deepseek-harness/deployment.json'),
        'utf8',
      ))
      expect(state).toEqual({
        checkout: repository,
        httpsPort: 443,
        provider: 'netbird',
        publicTarget: 'http://127.0.0.1:4080',
        serviceUser: 'node',
      })
    },
  )

  it.runIf(process.platform === 'linux')(
    'cleans up Tailscale ownership when reinstalling for NetBird',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      const config = join(fixture.systemRoot, 'etc/deepseek-harness.env')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          'DSH_VPN_PROVIDER=tailscale',
          'DSH_VPN_PROVIDER=netbird',
        ),
      )
      writeFileSync(fixture.calls, '')

      const result = runInstaller(fixture, { NETBIRD_CONNECTED: '1' })

      expect(result.status, result.stderr).toBe(0)
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).toContain('tailscale serve --yes --bg --https=443 off')
      expect(readFileSync(
        join(fixture.systemRoot, 'etc/systemd/system/deepseek-harness.service'),
        'utf8',
      )).not.toContain('tailscaled.service')
      const state = JSON.parse(readFileSync(
        join(fixture.systemRoot, 'var/lib/deepseek-harness/deployment.json'),
        'utf8',
      )) as { provider?: string }
      expect(state.provider).toBe('netbird')
    },
  )

  it.runIf(process.platform === 'linux')(
    'handles concurrent and failed Tailscale route cleanup during transition',
    () => {
      for (const failure of ['SERVE_OFF_RACE', 'FAIL_SERVE_OFF']) {
        const fixture = createInstallFixture()
        expect(runInstaller(fixture).status).toBe(0)
        const config = join(fixture.systemRoot, 'etc/deepseek-harness.env')
        writeFileSync(
          config,
          readFileSync(config, 'utf8').replace(
            'DSH_VPN_PROVIDER=tailscale',
            'DSH_VPN_PROVIDER=netbird',
          ),
        )
        writeFileSync(fixture.calls, '')

        const result = runInstaller(fixture, {
          [failure]: '1',
          NETBIRD_CONNECTED: '1',
        })

        expect(result.stderr).not.toContain('unbound variable')
        if (failure === 'SERVE_OFF_RACE') {
          expect(result.status, result.stderr).toBe(0)
        } else {
          expect(result.status).not.toBe(0)
          expect(readFileSync(fixture.calls, 'utf8')).toContain(
            'systemctl start deepseek-harness.service',
          )
        }
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'requires install to apply changed service ports',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      const config = join(fixture.systemRoot, 'etc/deepseek-harness.env')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          'DSH_PUBLIC_PORT=4080',
          'DSH_PUBLIC_PORT=4180',
        ),
      )
      writeFileSync(fixture.calls, '')

      const result = runLifecycle(fixture, 'restart')

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        "run './start.sh install' to apply them safely",
      )
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain(
        'systemctl restart deepseek-harness.service',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'recovers only exact legacy state for either installed provider',
    () => {
      for (const provider of ['tailscale', 'netbird']) {
        const fixture = createInstallFixture()
        expect(
          runInstaller(fixture, {
            DSH_VPN_PROVIDER: provider,
            NETBIRD_CONNECTED: '1',
          }).status,
        ).toBe(0)
        const statePath = join(
          fixture.systemRoot,
          'var/lib/deepseek-harness/deployment.json',
        )
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<
          string,
          unknown
        >
        delete state.provider
        state.unexpected = true
        writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
        expect(
          runInstaller(fixture, {
            DSH_VPN_PROVIDER: provider,
            NETBIRD_CONNECTED: '1',
          }).status,
        ).not.toBe(0)
        delete state.unexpected
        writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)

        const result = runInstaller(fixture, {
          DSH_VPN_PROVIDER: provider,
          NETBIRD_CONNECTED: '1',
        })

        expect(result.status, result.stderr).toBe(0)
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
          provider,
        })
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'rejects deployment state without its installed VPN provider',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      const statePath = join(fixture.systemRoot, 'var/lib/deepseek-harness/deployment.json')
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
      delete state.provider
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
      writeFileSync(fixture.calls, '')

      const result = runLifecycle(fixture, 'restart')

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('deployment state is malformed')
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain(
        'systemctl restart deepseek-harness.service',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'requires install to apply a changed VPN provider',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      const config = join(fixture.systemRoot, 'etc/deepseek-harness.env')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          'DSH_VPN_PROVIDER=tailscale',
          'DSH_VPN_PROVIDER=netbird',
        ),
      )
      writeFileSync(fixture.calls, '')

      const result = runLifecycle(fixture, 'restart')

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        "run './start.sh install' to apply them safely",
      )
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain(
        'systemctl restart deepseek-harness.service',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'stops an owned native service before rebuilding an update',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      writeFileSync(fixture.calls, '')
      const result = runInstaller(fixture)
      expect(result.status).toBe(0)
      const calls = readFileSync(fixture.calls, 'utf8').trim().split('\n')
      const stop = calls.indexOf('systemctl stop deepseek-harness.service')
      const build = calls.findIndex(line => line.endsWith('run build'))
      const start = calls.indexOf(
        'systemctl enable --now deepseek-harness.service',
      )
      expect(stop).toBeGreaterThan(-1)
      expect(stop).toBeLessThan(build)
      expect(build).toBeLessThan(start)
    },
  )

  it.runIf(process.platform === 'linux')(
    'restarts an owned native service when update build fails',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      writeFileSync(fixture.calls, '')
      const result = runInstaller(fixture, { PNPM_FAILURE: 'build' })
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain('Building checkout artifacts failed (')
      expect(result.stderr).toContain('pnpm verbose output')
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).toContain('systemctl stop deepseek-harness.service')
      expect(calls).toContain('systemctl start deepseek-harness.service')
      expect(calls).not.toContain(
        'systemctl enable --now deepseek-harness.service',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'removes a fresh unit and state when native readiness fails',
    () => {
      const fixture = createInstallFixture()
      const failed = runInstaller(fixture, { FAIL_NATIVE: '1' })
      expect(failed.status).not.toBe(0)
      expect(() =>
        readFileSync(
          join(
            fixture.systemRoot,
            'etc/systemd/system/deepseek-harness.service',
          ),
          'utf8',
        ),
      ).toThrow()
      expect(() =>
        readFileSync(
          join(fixture.systemRoot, 'var/lib/deepseek-harness/deployment.json'),
          'utf8',
        ),
      ).toThrow()
      expect(runInstaller(fixture).status).toBe(0)
    },
  )

  it.runIf(process.platform === 'linux')(
    'refuses a root Harness runtime',
    () => {
      const fixture = createInstallFixture()
      const result = runInstaller(fixture, { DSH_SERVICE_USER: 'root' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('refusing to run Harness as root')
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain('pnpm ')
    },
  )

  it.runIf(process.platform === 'linux')(
    'redacts the task-board token from readiness diagnostics',
    () => {
      const fixture = createInstallFixture()
      const token = 'known-task-board-secret'
      const result = runInstaller(fixture, {
        DSH_TASK_BOARD_PROXY_TOKEN: token,
        FAIL_NATIVE: '1',
        LEAK_TEXT: `backend environment: ${token}`,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).not.toContain(token)
      expect(result.stderr).toContain('backend environment: [redacted]')
    },
  )

  it.runIf(process.platform === 'linux')(
    'rejects a login shell that cannot run commands',
    () => {
      const fixture = createInstallFixture()
      const blockedShell = join(fixture.bin, 'nologin')
      executable(blockedShell, 'exit 1')
      const result = runInstaller(fixture, { LOGIN_SHELL: blockedShell })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'login shell cannot run non-interactive commands',
      )
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain('pnpm ')
    },
  )

  it.runIf(process.platform === 'linux')(
    'refuses to replace another Tailscale operator',
    () => {
      const fixture = createInstallFixture()
      const result = runInstaller(fixture, { TS_OPERATOR: 'other-user' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'Tailscale operator is already other-user; refusing to replace it with node',
      )
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).not.toContain(
        'systemctl enable --now deepseek-harness.service',
      )
      expect(calls).not.toContain('docker ')
    },
  )

  it.runIf(process.platform === 'linux')(
    'removes an exactly owned Docker deployment during native takeover',
    () => {
      const fixture = createInstallFixture()

      const result = runInstaller(fixture, {
        DOCKER_REPO: join(repository, 'docker'),
        OWNED_DOCKER: '1',
      })

      expect(result.status, result.stderr).toBe(0)
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).toContain('docker rm -f dsh-id auth-proxy-id')
      expect(calls.indexOf('docker rm -f')).toBeLessThan(
        calls.indexOf('systemctl enable --now deepseek-harness.service'),
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'does not recreate removed Docker containers when native readiness fails',
    () => {
      const fixture = createInstallFixture()

      const result = runInstaller(fixture, {
        FAIL_NATIVE: '1',
        OWNED_DOCKER: '1',
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'rerun install after resolving the reported failure',
      )
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).toContain('docker rm -f dsh-id auth-proxy-id')
      expect(calls).not.toContain('docker start')
    },
  )

  it.runIf(process.platform === 'linux')(
    'preserves Docker deployments owned by another checkout',
    () => {
      const fixture = createInstallFixture()

      const result = runInstaller(fixture, {
        DOCKER_REPO: join(fixture.root, 'other-checkout'),
        OWNED_DOCKER: '1',
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain('docker rm')
    },
  )

  it.runIf(process.platform === 'linux').each([
    ['the explicit service home', 'explicit'],
    ['the HOME fallback', 'default'],
    ['a tilde service home', 'tilde'],
    ['another home', 'other'],
  ] as const)(
    'handles a dsh web process using %s',
    async (_case, mode) => {
      const fixture = createInstallFixture()
      const competingEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: fixture.home,
      }
      delete competingEnv.DSH_HOME
      if (mode !== 'default') {
        competingEnv.DSH_HOME =
          mode === 'explicit'
            ? join(fixture.home, '.dsh')
            : mode === 'tilde'
              ? '~/.dsh'
              : join(fixture.root, 'other-home', '.dsh')
      }
      const competing = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1_000)', 'dsh', 'web'],
        {
          env: competingEnv,
          stdio: 'ignore',
        },
      )
      const exited = waitForExit(competing)
      try {
        await once(competing, 'spawn')
        const result = runInstaller(fixture)
        const calls = readFileSync(fixture.calls, 'utf8')
        if (mode !== 'other') {
          expect(result.status).not.toBe(0)
          expect(result.stderr).toContain(
            `another dsh web process already uses ${join(fixture.home, '.dsh')}`,
          )
          expect(calls).not.toContain(
            'systemctl enable --now deepseek-harness.service',
          )
        } else {
          expect(result.status, result.stderr).toBe(0)
          expect(calls).toContain(
            'systemctl enable --now deepseek-harness.service',
          )
        }
        expect(competing.exitCode).toBeNull()
      } finally {
        competing.kill('SIGTERM')
        await exited
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'refuses an unrelated loopback listener',
    () => {
      const fixture = createInstallFixture()
      const result = runInstaller(fixture, { OCCUPIED_PORT: '4080' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'loopback port 4080 is already owned by another listener',
      )
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain(
        'systemctl enable --now deepseek-harness.service',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'refuses to replace an unrelated Tailscale Serve route',
    () => {
      const fixture = createInstallFixture()
      const result = runInstaller(fixture, {
        TS_TARGET: 'http://127.0.0.1:9999',
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'Tailscale Serve HTTPS port 443 is already owned by http://127.0.0.1:9999',
      )
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).not.toContain(
        'systemctl enable --now deepseek-harness.service',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'preserves an installed unit when its Tailscale route changed',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      writeFileSync(fixture.calls, '')
      const result = runLifecycle(fixture, 'uninstall', {
        TS_TARGET: 'http://127.0.0.1:9999',
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(
        'Tailscale Serve HTTPS port 443 is owned by http://127.0.0.1:9999, not this installation',
      )
      expect(
        readFileSync(
          join(
            fixture.systemRoot,
            'etc/systemd/system/deepseek-harness.service',
          ),
          'utf8',
        ),
      ).toContain('Description=DeepSeek Harness')
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain(
        'systemctl disable --now deepseek-harness.service',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'uses the installed provider when configuration changes before uninstall',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      const config = join(fixture.systemRoot, 'etc/deepseek-harness.env')
      writeFileSync(
        config,
        readFileSync(config, 'utf8').replace(
          'DSH_VPN_PROVIDER=tailscale',
          'DSH_VPN_PROVIDER=netbird',
        ),
      )
      writeFileSync(fixture.calls, '')

      const result = runLifecycle(fixture, 'uninstall')

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(fixture.calls, 'utf8')).toContain(
        'tailscale serve --yes --bg --https=443 off',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'removes only owned service files and preserves configuration',
    () => {
      const fixture = createInstallFixture()
      expect(runInstaller(fixture).status).toBe(0)
      writeFileSync(fixture.calls, '')
      const result = runLifecycle(fixture, 'uninstall')
      expect(result.status).toBe(0)
      const calls = readFileSync(fixture.calls, 'utf8')
      expect(calls).toContain(
        'systemctl disable --now deepseek-harness.service',
      )
      expect(calls).toContain('tailscale serve --yes --bg --https=443 off')
      expect(() =>
        readFileSync(
          join(
            fixture.systemRoot,
            'etc/systemd/system/deepseek-harness.service',
          ),
          'utf8',
        ),
      ).toThrow()
      expect(
        readFileSync(
          join(fixture.systemRoot, 'etc/deepseek-harness.env'),
          'utf8',
        ),
      ).toContain('DSH_PUBLIC_PORT=4080')
      expect(
        readFileSync(
          join(fixture.systemRoot, 'var/lib/deepseek-harness/deployment.json'),
          'utf8',
        ),
      ).toContain('"serviceUser": "node"')
    },
  )

  it.runIf(process.platform === 'linux')(
    'rejects a symlinked root service configuration',
    () => {
      const fixture = createInstallFixture()
      const config = join(fixture.systemRoot, 'etc/deepseek-harness.env')
      const target = join(fixture.root, 'linked-config')
      mkdirSync(join(fixture.systemRoot, 'etc'), { recursive: true })
      writeFileSync(target, 'DSH_BACKEND_PORT=4081\n')
      symlinkSync(target, config)
      const result = runInstaller(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('must be a non-symlink regular file')
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain(
        'systemctl enable --now deepseek-harness.service',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'rejects shell syntax in root service configuration',
    () => {
      const fixture = createInstallFixture()
      const config = join(fixture.systemRoot, 'etc/deepseek-harness.env')
      const marker = join(fixture.root, 'executed')
      mkdirSync(join(fixture.systemRoot, 'etc'), { recursive: true })
      writeFileSync(
        config,
        `DSH_BACKEND_PORT=4081\nDSH_PUBLIC_PORT=4080\nDSH_HTTPS_PORT=443\nDSH_STARTUP_TIMEOUT=90\nTAILSCALE_OWNER=$(touch ${marker})\nDSH_EXTRA_TRUSTED_HOSTS=\n`,
      )
      const result = runInstaller(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('unsupported or malformed setting')
      expect(() => readFileSync(marker, 'utf8')).toThrow()
    },
  )

  it.runIf(process.platform === 'linux')(
    'rejects a writable root service configuration',
    () => {
      const fixture = createInstallFixture()
      const config = join(fixture.systemRoot, 'etc/deepseek-harness.env')
      mkdirSync(join(fixture.systemRoot, 'etc'), { recursive: true })
      writeFileSync(
        config,
        'DSH_BACKEND_PORT=4081\nDSH_PUBLIC_PORT=4080\nDSH_HTTPS_PORT=443\nDSH_STARTUP_TIMEOUT=90\nTAILSCALE_OWNER=owner@example.test\nDSH_EXTRA_TRUSTED_HOSTS=\n',
      )
      const result = runInstaller(fixture, { STAT_OUTPUT: '0 666' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('must not be group- or world-writable')
      expect(readFileSync(fixture.calls, 'utf8')).not.toContain(
        'systemctl enable --now deepseek-harness.service',
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'prints exact Arch dependency guidance without installing packages',
    () => {
      const fixture = createInstallFixture()
      unlinkSync(join(fixture.bin, 'caddy'))
      writeFileSync(join(fixture.systemRoot, 'etc/os-release'), 'ID=arch\n')
      const result = runInstaller(fixture)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('sudo pacman -S caddy tailscale')
      expect(result.stderr).toContain('Node.js ^22.19.0 or >=24.0.0')
      expect(result.stderr).toContain('pnpm 11.7.0')
      expect(readFileSync(fixture.calls, 'utf8')).not.toMatch(
        /^(apt|dnf|pacman) /m,
      )
    },
  )

  it.runIf(process.platform === 'linux')(
    'renders a non-root system service without host restrictions',
    () => {
      const rendered = spawnSync(
        'bash',
        [
          '-c',
          'source "$1/scripts/deployment/common.sh"; source "$1/scripts/deployment/native-service.sh"; native_render_unit node node /home/node "$1" /bin/bash "$1/start.sh" /etc/deepseek-harness.env',
          '_',
          repository,
        ],
        { encoding: 'utf8' },
      )
      expect(rendered.status).toBe(0)
      expect(rendered.stdout).toContain('Description=DeepSeek Harness')
      expect(rendered.stdout).toContain('Type=notify')
      expect(rendered.stdout).toContain('NotifyAccess=all')
      expect(rendered.stdout).toContain('User=node')
      expect(rendered.stdout).toContain('Group=node')
      expect(rendered.stdout).toContain('RuntimeDirectory=deepseek-harness')
      expect(rendered.stdout).toContain('UMask=0077')
      expect(rendered.stdout).toContain('KillMode=mixed')
      expect(rendered.stdout).not.toContain('ProtectHome=')
      expect(rendered.stdout).not.toContain('NoNewPrivileges=')

      const unitDirectory = mkdtempSync(join(tmpdir(), 'dsh-systemd-unit-'))
      const unitPath = join(
        unitDirectory,
        `dsh-native-test-${process.pid}.service`,
      )
      writeFileSync(unitPath, rendered.stdout)
      const verified = spawnSync('systemd-analyze', ['verify', unitPath], {
        encoding: 'utf8',
      })
      expect(verified.stderr).not.toContain(`${unitPath}:`)
      expect(verified.stderr).not.toContain(
        `dsh-native-test-${process.pid}.service:`,
      )
    },
  )
})

describe('native Harness runtime', () => {
  it.runIf(process.platform === 'linux')(
    'refuses another dsh web process using the service home',
    async () => {
      const fixture = createRuntimeFixture()
      const competing = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1_000)', 'dsh', 'web'],
        {
          env: {
            ...process.env,
            DSH_HOME: join(fixture.root, '.dsh'),
            HOME: fixture.root,
          },
          stdio: 'ignore',
        },
      )
      const competingExit = waitForExit(competing)
      try {
        await once(competing, 'spawn')
        const result = await waitForExit(spawnRuntime(fixture))
        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain(
          `another dsh web process already uses ${join(fixture.root, '.dsh')}`,
        )
        expect(competing.exitCode).toBeNull()
      } finally {
        competing.kill('SIGTERM')
        await competingExit
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'reports ready only after identity and API namespace probes pass',
    async () => {
      const fixture = createRuntimeFixture()
      const child = spawnRuntime(fixture)
      try {
        await waitForLog(fixture.calls, 'notify --ready')
        expect(readFileSync(join(fixture.runtime, 'backend-url'), 'utf8')).toBe(
          'http://127.0.0.1:4081/?token=fixture-token\n',
        )
        child.kill('SIGTERM')
        await waitForExit(child)
        const log = readFileSync(fixture.calls, 'utf8')
        expect(log).toContain(
          'tailscale serve --yes --bg --https=443 http://127.0.0.1:4080',
        )
        expect(log).toContain(
          'caddy start token=fixture-token provider=tailscale bind=127.0.0.1',
        )
        expect(log.indexOf('backend start')).toBeLessThan(
          log.indexOf('caddy start token=fixture-token'),
        )
        expect(log).toContain('backend TERM')
        expect(log).toContain('caddy TERM')
        expect(log).not.toContain('caddy inherited notify')
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'serves the Harness directly on the NetBird address',
    async () => {
      const fixture = createRuntimeFixture()
      writeFileSync(
        fixture.config,
        readFileSync(fixture.config, 'utf8')
          .replace('TAILSCALE_OWNER=owner@example.test\n', '')
          .replace('DSH_BACKEND_PORT=4081', 'DSH_VPN_PROVIDER=netbird\nDSH_BACKEND_PORT=4081'),
      )
      const child = spawnRuntime(fixture, { NETBIRD_CONNECTED: '1' })
      try {
        await waitForLog(fixture.calls, 'notify --ready')
        child.kill('SIGTERM')
        await waitForExit(child)
        const log = readFileSync(fixture.calls, 'utf8')
        expect(log).toContain('caddy start token=fixture-token provider=netbird bind=100.64.0.2')
        expect(log).toContain('notify --ready')
        expect(log).toContain('Serving http://100.64.0.2:4080/')
        expect(log).not.toContain('tailscale serve')
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'withholds readiness when an unowned identity reaches the API namespace',
    async () => {
      const fixture = createRuntimeFixture()
      const result = await waitForExit(
        spawnRuntime(fixture, { SCOPE_DENIED_STATUS: '404' }),
      )
      const log = readFileSync(fixture.calls, 'utf8')
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(
        'Tailscale API namespace self-check failed (denied=404 allowed=404)',
      )
      expect(log).not.toContain('notify --ready')
      expect(log).toContain('backend TERM')
      expect(log).toContain('caddy TERM')
    },
  )

  it.runIf(process.platform === 'linux')(
    'accepts an unauthenticated 404 while waiting for the token-protected Web roots',
    async () => {
      const fixture = createRuntimeFixture()
      const child = spawnRuntime(fixture, { ROOT_STATUS: '404' })
      try {
        await waitForLog(fixture.calls, 'notify --ready')
        child.kill('SIGTERM')
        await waitForExit(child)
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'retries owner authorization while API routes finish mounting',
    async () => {
      const fixture = createRuntimeFixture()
      const child = spawnRuntime(fixture, { OWNER_404_ONCE: '1' })
      try {
        await waitForLog(fixture.calls, 'notify --ready')
        child.kill('SIGTERM')
        await waitForExit(child)
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'starts the backend from a non-executable runtime launcher',
    async () => {
      const fixture = createRuntimeFixture()
      const child = spawnRuntime(fixture)
      try {
        await waitForLog(fixture.calls, 'backend start')
        child.kill('SIGTERM')
        await waitForExit(child)
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'starts the backend with pnpm outside the systemd PATH',
    async () => {
      const fixture = createRuntimeFixture()
      const pnpm = join(fixture.root, 'pnpm')
      renameSync(join(fixture.bin, 'pnpm'), pnpm)
      const child = spawnRuntime(fixture, { DSH_PNPM_BIN: pnpm })
      try {
        await waitForLog(fixture.calls, 'backend start')
        child.kill('SIGTERM')
        await waitForExit(child)
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    },
  )

  it.runIf(process.platform === 'linux')(
    'withholds readiness when the configured owner is denied',
    async () => {
      const fixture = createRuntimeFixture()
      const result = await waitForExit(
        spawnRuntime(fixture, { OWNER_STATUS: '403' }),
      )
      const log = readFileSync(fixture.calls, 'utf8')
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(
        'Tailscale identity proxy self-check failed (denied=403 allowed=403)',
      )
      expect(log).not.toContain('notify --ready')
      expect(log).toContain('backend TERM')
      expect(log).toContain('caddy TERM')
    },
  )

  it.runIf(process.platform === 'linux')(
    'terminates Harness when Caddy exits before readiness',
    async () => {
      const fixture = createRuntimeFixture()
      const result = await waitForExit(
        spawnRuntime(fixture, { CADDY_EXIT: '1' }),
      )
      const log = readFileSync(fixture.calls, 'utf8')
      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(
        /Caddy proxy exited before (becoming ready|service readiness)/,
      )
      expect(log).not.toContain('notify --ready')
      expect(log.includes('backend TERM')).toBe(log.includes('backend start'))
    },
  )
})

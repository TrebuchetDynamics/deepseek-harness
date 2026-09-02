import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '..')
const launcher = join(repository, 'run-docker.sh')
const entrypoint = join(repository, 'docker/dsh-entrypoint.sh')
const dockerfile = join(repository, 'Dockerfile')
const caddyfile = join(repository, 'deployment/Caddyfile')
const commonDeployment = join(repository, 'scripts/deployment/common.sh')

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`)
  chmodSync(path, 0o755)
}

describe('Docker Tailscale proxy', () => {
  it('preserves browser authority for owner APIs and denies other identities', () => {
    const config = readFileSync(caddyfile, 'utf8')
    const ownerMatcher = config.slice(
      config.indexOf('@owner_api'),
      config.indexOf('handle @owner_api'),
    )
    const ownerProxy = config.slice(
      config.indexOf('handle @owner_api'),
      config.indexOf('@api'),
    )
    const ownerIndexMatcher = config.slice(
      config.indexOf('@owner_index_without_cookie'),
      config.indexOf('handle @owner_index_without_cookie'),
    )
    const ownerTaskBoardMatcher = config.slice(
      config.indexOf('@owner_task_board'),
      config.indexOf('handle @owner_task_board'),
    )
    expect(config).toContain('@owner_index_without_cookie')
    expect(ownerIndexMatcher).toContain('{env.DSH_VPN_PROVIDER} == "tailscale"')
    expect(ownerTaskBoardMatcher).toContain(
      'expression `{env.DSH_VPN_PROVIDER} == "tailscale"`',
    )
    expect(config).toContain(
      'rewrite * /?token={$DSH_BROWSER_LAUNCH_TOKEN}',
    )
    expect(ownerMatcher).toContain('expression `{env.DSH_VPN_PROVIDER} == "tailscale"`')
    expect(ownerMatcher).toContain('path /api /api/*')
    expect(ownerMatcher).not.toContain('/api/settings/*')
    expect(ownerProxy).not.toContain('header_up Host')
    expect(config).not.toContain('header_up Host')
    expect(config).toContain('handle @api {\n\t\trespond 403')
  })

  it('treats token-protected root responses as container readiness', () => {
    expect(readFileSync(dockerfile, 'utf8')).toContain(
      'curl -sS http://127.0.0.1:${DSH_PORT:-3080}/',
    )
    expect(readFileSync(launcher, 'utf8')).toContain(
      'curl -sS -o /dev/null "$proxy/"',
    )
  })

  it('preserves an absent Origin header on ordinary requests', () => {
    const config = readFileSync(caddyfile, 'utf8')
    const ordinaryProxy = config.slice(config.lastIndexOf('handle {'))
    expect(ordinaryProxy).not.toContain(
      'header_up Origin {http.request.header.Origin}',
    )
  })

  it('shares deployment identity and locking policy', () => {
    const launcherSource = readFileSync(launcher, 'utf8')
    const commonSource = readFileSync(commonDeployment, 'utf8')
    const composeSource = readFileSync(
      join(repository, 'docker/docker-compose.yml'),
      'utf8',
    )
    expect(launcherSource).toContain(
      'source "$SCRIPT_DIR/scripts/deployment/common.sh"',
    )
    expect(launcherSource).toContain(
      'dsh_acquire_deployment_lock "$DSH_HOST_USER_HOME"',
    )
    expect(commonSource).toContain('dsh_probe_identity_proxy()')
    expect(composeSource).toContain(
      '../deployment/Caddyfile:/etc/caddy/Caddyfile:ro',
    )
    expect(composeSource).toContain('DSH_BIND_ADDRESS=127.0.0.1')
    expect(composeSource).toContain('DSH_VPN_PROVIDER=tailscale')
  })
})

describe('browser e2e Docker wrapper', () => {
  it.runIf(process.platform !== 'win32')('requires Docker but not host Node or pnpm', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-browser-e2e-wrapper-'))
    try {
      const bin = join(root, 'bin')
      const calls = join(root, 'docker.log')
      mkdirSync(bin)
      executable(join(bin, 'node'), 'exit 99')
      executable(join(bin, 'pnpm'), 'exit 99')
      executable(join(bin, 'docker'), 'printf "%s\\n" "$*" >> "$CALLS"')

      const result = spawnSync('bash', [join(repository, 'docker/browser-e2e/run.sh'), '--', 'true'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          CALLS: calls,
          HOME: root,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          XDG_CACHE_HOME: join(root, 'cache'),
        },
      })

      expect(result.status, result.stderr).toBe(0)
      const dockerCalls = readFileSync(calls, 'utf8')
      expect(dockerCalls).toContain('build --build-arg PNPM_VERSION=')
      expect(dockerCalls).toContain('run --rm')
      expect(dockerCalls).toContain('PNPM_CONFIG_STORE_DIR=/tmp/pnpm-store')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Docker Harness entrypoint', () => {
  it('packages the Docker client used with the mounted host engine', () => {
    const source = readFileSync(dockerfile, 'utf8')
    expect(source).toContain('FROM docker:28-cli AS docker-cli')
    expect(source).toContain(
      'COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker',
    )
    expect(source).toContain(
      'COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins',
    )
  })

  it.runIf(process.platform === 'linux')(
    'preserves the Docker socket group when dropping privileges',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-docker-entrypoint-'))
      const bin = join(root, 'bin')
      const checkout = join(root, 'checkout')
      const calls = join(root, 'calls.log')
      mkdirSync(bin)
      mkdirSync(checkout)
      writeFileSync(
        join(checkout, 'package.json'),
        '{"scripts":{"dsh":"true"}}\n',
      )
      executable(join(bin, 'setpriv'), 'printf "%s\\n" "$*" > "$CALLS"')
      executable(join(bin, 'chown'), ':')

      const result = spawnSync(entrypoint, {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          CALLS: calls,
          DSH_REPO: checkout,
          DSH_HOME: join(root, '.dsh'),
          DSH_UID: '1200',
          DSH_GID: '1201',
          DSH_DOCKER_GID: '984',
          FLUTTER_ROOT: join(root, 'missing-flutter'),
          ANDROID_HOME: join(root, 'missing-android'),
          JAVA_HOME: join(root, 'missing-java'),
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      })

      expect(result.status).toBe(0)
      const args = readFileSync(calls, 'utf8')
      expect(args).toContain('--groups 984')
      expect(args).not.toContain('--clear-groups')
    },
  )
})

describe('run-docker launcher', () => {
  it.runIf(process.platform === 'linux')(
    'installs and builds the checkout before the image',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-run-docker-'))
      const bin = join(root, 'bin')
      const home = join(root, 'home')
      const checkout = join(home, 'checkout')
      const calls = join(root, 'calls.log')
      mkdirSync(bin)
      mkdirSync(join(checkout, 'packages/client'), { recursive: true })
      mkdirSync(join(home, 'git'))
      writeFileSync(
        join(checkout, 'package.json'),
        '{"scripts":{"dsh":"true"}}\n',
      )
      writeFileSync(join(checkout, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
      execFileSync('git', ['init', '--quiet', checkout])

      executable(
        join(bin, 'pnpm'),
        'printf "pnpm %s\\n" "$*" >> "$CALLS"\ncase "${PNPM_FAILURE:-}:$*" in build:*" run build") exit 9 ;; esac\nmkdir -p "$CHECKOUT/node_modules" "$CHECKOUT/apps/web/dist"\ntouch "$CHECKOUT/apps/web/dist/index.html"',
      )
      executable(
        join(bin, 'docker'),
        'printf "docker %s\\n" "$*" >> "$CALLS"\n[ "$*" != "--version" ] || echo "Docker version 28"\ncase "$*" in *" logs --no-color dsh") echo "dsh web: http://127.0.0.1:4081/?token=fixture-token" ;; esac',
      )
      executable(
        join(bin, 'tailscale'),
        `case "$*" in
  "status --json") printf '%s\\n' '{"Self":{"DNSName":"host.tail.test.","UserID":1},"User":{"1":{"LoginName":"owner@example.test"}}}' ;;
  "ip -4") echo 100.64.0.1 ;;
  *) printf "tailscale %s\\n" "$*" >> "$CALLS" ;;
esac`,
      )
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
  *__dsh_api_namespace_probe__*unauthorized@example.invalid*) printf 403 ;;
  *__dsh_api_namespace_probe__*owner@example.test*) printf 404 ;;
  *unauthorized@example.invalid*) printf 403 ;;
  *owner@example.test*) printf 200 ;;
esac`,
      )
      executable(
        join(bin, 'systemctl'),
        '[ "${NATIVE_ACTIVE:-0}" != 1 ] || [ "$*" != "is-active --quiet deepseek-harness.service" ] || exit 0\nexit 3',
      )

      const env = {
        ...process.env,
        CALLS: calls,
        CHECKOUT: checkout,
        DSH_REPO: checkout,
        TAILSCALE_OWNER: 'owner@example.test',
        DSH_HOST_USER_HOME: home,
        DSH_HOST_WORKSPACE: join(home, 'git'),
        DSH_HOST_FLUTTER_HOME: join(root, 'missing-flutter'),
        DSH_HOST_ANDROID_HOME: join(root, 'missing-android'),
        DSH_HOST_JAVA_HOME: join(root, 'missing-java'),
        DSH_ENABLE_HOST_DOCKER: '0',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      }
      const nativeActive = spawnSync(launcher, {
        cwd: repository,
        encoding: 'utf8',
        env: { ...env, NATIVE_ACTIVE: '1' },
      })
      expect(nativeActive.status).toBe(1)
      expect(nativeActive.stderr).toContain(
        'deepseek-harness.service is active; run ./start.sh stop before Docker deployment',
      )
      expect(readFileSync(calls, 'utf8')).not.toContain(' stop dsh auth-proxy')
      writeFileSync(calls, '')

      const result = spawnSync(launcher, {
        cwd: repository,
        encoding: 'utf8',
        env,
      })

      expect(result.stderr).toBe(
        'warning: Flutter executable not found at ' +
          join(root, 'missing-flutter') +
          '; continuing without Flutter\nwarning: DSH_HOST_ANDROID_HOME has no platform-tools/adb; continuing without the Android SDK\nwarning: Java executable not found at ' +
          join(root, 'missing-java') +
          '; continuing without Java\n',
      )
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(
        'Web UI: https://host.tail.test/?token=fixture-token',
      )
      const log = readFileSync(calls, 'utf8')
      expect(log).toContain(
        `pnpm --dir ${checkout} install --frozen-lockfile\npnpm --dir ${checkout} run build\n`,
      )
      const callsInOrder = log.trim().split('\n')
      const compositionStop = callsInOrder.findIndex(
        line =>
          line.startsWith('docker compose ') &&
          line.endsWith(' stop dsh auth-proxy'),
      )
      const checkoutBuild = callsInOrder.findIndex(line =>
        line.endsWith(' run build'),
      )
      const imageBuild = callsInOrder.findIndex(
        line => line.startsWith('docker compose ') && line.endsWith(' build'),
      )
      expect(compositionStop).toBeGreaterThan(-1)
      expect(compositionStop).toBeLessThan(checkoutBuild)
      expect(checkoutBuild).toBeLessThan(imageBuild)

      writeFileSync(calls, '')
      const failed = spawnSync(launcher, {
        cwd: repository,
        encoding: 'utf8',
        env: { ...env, PNPM_FAILURE: 'build' },
      })
      expect(failed.status).toBe(1)
      expect(failed.stderr).toContain(`checkout build failed: ${checkout}`)
      expect(readFileSync(calls, 'utf8')).not.toMatch(
        /docker compose .* build/,
      )

      const invalid = join(home, 'not-a-repository')
      mkdirSync(invalid)
      writeFileSync(calls, '')
      const rejected = spawnSync(launcher, {
        cwd: repository,
        encoding: 'utf8',
        env: { ...env, DSH_REPO: invalid },
      })
      expect(rejected.status).toBe(1)
      expect(rejected.stderr).toContain(
        `DSH_REPO must be the root of a Git checkout: ${invalid}`,
      )
      expect(readFileSync(calls, 'utf8')).not.toContain(' stop dsh auth-proxy')

      const profile = join(home, '.dsh/profiles/web')
      const aggregate = join(profile, 'node_modules/@linxin666/dsh-web-ui-all')
      mkdirSync(aggregate, { recursive: true })
      writeFileSync(
        join(profile, 'package.json'),
        '{"dsh":{"profile":{"bundles":["@linxin666/dsh-web-ui-all","dsh-better-sidebar"]}}}\n',
      )
      writeFileSync(
        join(aggregate, 'package.json'),
        '{"dependencies":{"dsh-better-sidebar":"0.14.0"}}\n',
      )
      writeFileSync(calls, '')
      const duplicate = spawnSync(launcher, {
        cwd: repository,
        encoding: 'utf8',
        env,
      })
      expect(duplicate.status).toBe(1)
      expect(duplicate.stderr).toContain(
        'profile web loads dsh-better-sidebar from multiple bundles: @linxin666/dsh-web-ui-all, dsh-better-sidebar',
      )
      expect(duplicate.stderr).toContain(
        'pnpm dsh plugin --profile web remove dsh-better-sidebar',
      )
      expect(readFileSync(calls, 'utf8')).not.toContain(' stop dsh auth-proxy')

      writeFileSync(join(aggregate, 'package.json'), '{"dependencies":{}}\n')
      writeFileSync(calls, '')
      const independent = spawnSync(launcher, {
        cwd: repository,
        encoding: 'utf8',
        env,
      })
      expect(independent.status).toBe(0)
      expect(readFileSync(calls, 'utf8')).toContain(' stop dsh auth-proxy')
    },
  )

  it.runIf(process.platform === 'linux')(
    'exposes a selected local Docker engine to the Harness process by default',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'dsh-run-docker-engine-'))
      const bin = join(root, 'bin')
      const home = join(root, 'home')
      const checkout = join(home, 'checkout')
      const calls = join(root, 'calls.log')
      const overrideCapture = join(root, 'docker-compose.host.yml')
      const socket = join(root, 'docker.sock')
      mkdirSync(bin)
      mkdirSync(join(checkout, 'packages/client'), { recursive: true })
      mkdirSync(join(home, 'git'))
      writeFileSync(
        join(checkout, 'package.json'),
        '{"scripts":{"dsh":"true"}}\n',
      )
      writeFileSync(join(checkout, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
      execFileSync('git', ['init', '--quiet', checkout])
      executable(
        join(bin, 'pnpm'),
        'mkdir -p "$CHECKOUT/node_modules" "$CHECKOUT/apps/web/dist"\ntouch "$CHECKOUT/apps/web/dist/index.html"',
      )
      executable(
        join(bin, 'docker'),
        `printf "docker %s\\n" "$*" >> "$CALLS"
case "$*" in
  "--version") echo "Docker version 28" ;;
  "context inspect --format {{.Endpoints.docker.Host}}") echo "tcp://remote.example.test:2376" ;;
  *" logs --no-color dsh") echo "dsh web: http://127.0.0.1:4081/?token=fixture-token" ;;
esac
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-f" ]; then
    shift
    case "$1" in *docker-compose.host.yml) cp "$1" "$OVERRIDE_CAPTURE" ;; esac
  fi
  shift
done`,
      )
      executable(
        join(bin, 'tailscale'),
        `case "$*" in
  "status --json") printf '%s\\n' '{"Self":{"DNSName":"host.tail.test.","UserID":1},"User":{"1":{"LoginName":"owner@example.test"}}}' ;;
  "ip -4") echo 100.64.0.1 ;;
esac`,
      )
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
  *__dsh_api_namespace_probe__*unauthorized@example.invalid*) printf 403 ;;
  *__dsh_api_namespace_probe__*owner@example.test*) printf 404 ;;
  *unauthorized@example.invalid*) printf 403 ;;
  *owner@example.test*) printf 200 ;;
esac`,
      )
      executable(join(bin, 'systemctl'), 'exit 3')
      const server = createServer()
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(socket, resolveListen)
      })
      try {
        const result = spawnSync(launcher, {
          cwd: repository,
          encoding: 'utf8',
          env: {
            ...process.env,
            CALLS: calls,
            CHECKOUT: checkout,
            OVERRIDE_CAPTURE: overrideCapture,
            DOCKER_HOST: `unix://${socket}`,
            DSH_REPO: checkout,
            TAILSCALE_OWNER: 'owner@example.test',
            DSH_HOST_USER_HOME: home,
            DSH_HOST_WORKSPACE: join(home, 'git'),
            DSH_HOST_FLUTTER_HOME: join(root, 'missing-flutter'),
            DSH_HOST_ANDROID_HOME: join(root, 'missing-android'),
            DSH_HOST_JAVA_HOME: join(root, 'missing-java'),
            PATH: `${bin}:${process.env.PATH ?? ''}`,
          },
        })
        expect(result.status, result.stderr).toBe(0)
        const override = readFileSync(overrideCapture, 'utf8')
        expect(override).toContain(`${socket}:/var/run/docker.sock`)
        expect(override).toContain('DOCKER_HOST=unix:///var/run/docker.sock')
        expect(override).toMatch(/DSH_DOCKER_GID=\d+/)
      } finally {
        await new Promise<void>((resolveClose) => {
          server.close(() => {
            resolveClose()
          })
        })
      }
    },
  )
})

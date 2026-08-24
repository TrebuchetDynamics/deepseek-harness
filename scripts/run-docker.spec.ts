import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  it('rewrites owner SSH API requests to loopback', () => {
    const config = readFileSync(caddyfile, 'utf8')
    const ownerMatcher = config.slice(
      config.indexOf('@owner_sensitive'),
      config.indexOf('handle @owner_sensitive'),
    )
    expect(ownerMatcher).toContain('/api/dsh-ssh/*')
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
        'printf "docker %s\\n" "$*" >> "$CALLS"\n[ "$*" != "--version" ] || echo "Docker version 28"',
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

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
import { describe, expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '..')
const launcher = join(repository, 'run-docker.sh')

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}`)
  chmodSync(path, 0o755)
}

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
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      }
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
    },
  )
})

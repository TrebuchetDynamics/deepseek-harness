/** Integration coverage for the fork's rerunnable upstream merge helper. */

import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const helper = fileURLToPath(new URL('../upstream-merge.sh', import.meta.url))
const fixtures: string[] = []

interface Fixture {
  env: NodeJS.ProcessEnv
  fork: string
  installLog: string
  upstream: string
}

interface CommandResult {
  status: number | null
  stderr: string
  stdout: string
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true })
})

function git(fixture: Fixture, root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: fixture.env,
  }).trim()
}

function commit(fixture: Fixture, root: string, message: string): void {
  git(fixture, root, ['add', '.'])
  git(fixture, root, ['commit', '--quiet', '-m', message])
}

function write(root: string, path: string, content: string): void {
  writeFileSync(join(root, path), content)
}

function createFixture(): Fixture {
  const container = mkdtempSync(join(tmpdir(), 'dsh-upstream-merge-'))
  fixtures.push(container)
  const upstream = join(container, 'upstream')
  const fork = join(container, 'fork')
  const fakeBin = join(container, 'bin')
  const installLog = join(container, 'pnpm.log')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_EMAIL: 'merge-helper@example.test',
    GIT_AUTHOR_NAME: 'Merge Helper Test',
    GIT_COMMITTER_EMAIL: 'merge-helper@example.test',
    GIT_COMMITTER_NAME: 'Merge Helper Test',
    GIT_CONFIG_GLOBAL: join(container, 'global.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_DEFAULT_HASH: 'sha1',
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    PNPM_LOG: installLog,
  }
  const fixture = { env, fork, installLog, upstream }

  execFileSync('git', ['init', '--quiet', '--initial-branch=master', upstream], { env })
  write(upstream, 'Dockerfile', 'ARG DSH_VERSION=1.0.0\n')
  write(upstream, 'package.json', '{"version":"1.0.0"}\n')
  write(upstream, 'pnpm-lock.yaml', 'lockfileVersion: base\n')
  commit(fixture, upstream, 'base')
  execFileSync('git', ['clone', '--quiet', upstream, fork], { env })
  git(fixture, fork, ['remote', 'rename', 'origin', 'upstream'])

  copyFileSync(helper, join(fork, 'upstream-merge.sh'))
  chmodSync(join(fork, 'upstream-merge.sh'), 0o755)
  mkdirSync(fakeBin)
  const fakePnpm = join(fakeBin, 'pnpm')
  writeFileSync(fakePnpm, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$PNPM_LOG"\n')
  chmodSync(fakePnpm, 0o755)
  return fixture
}

function runHelper(fixture: Fixture): CommandResult {
  const result = spawnSync('bash', ['./upstream-merge.sh'], {
    cwd: fixture.fork,
    encoding: 'utf8',
    env: fixture.env,
  })
  return { status: result.status, stderr: result.stderr, stdout: result.stdout }
}

function pnpmCalls(fixture: Fixture): string[] {
  if (!existsSync(fixture.installLog)) return []
  return readFileSync(fixture.installLog, 'utf8').trim().split('\n')
}

describe('upstream merge helper', () => {
  it('installs a lockfile changed by a normal merge', () => {
    const fixture = createFixture()
    write(fixture.upstream, 'pnpm-lock.yaml', 'lockfileVersion: upstream\n')
    commit(fixture, fixture.upstream, 'update lockfile')

    const result = runHelper(fixture)

    expect(result.status, result.stderr).toBe(0)
    expect(pnpmCalls(fixture)).toEqual(['install', 'run typecheck'])
    expect(git(fixture, fixture.fork, ['merge-base', '--is-ancestor', 'upstream/master', 'HEAD'])).toBe('')
  })

  it('installs a conflicted lockfile after resolution and skips reinstall once validated', () => {
    const fixture = createFixture()
    write(fixture.fork, 'pnpm-lock.yaml', 'lockfileVersion: fork\n')
    commit(fixture, fixture.fork, 'fork lockfile')
    write(fixture.upstream, 'pnpm-lock.yaml', 'lockfileVersion: upstream\n')
    commit(fixture, fixture.upstream, 'upstream lockfile')

    const conflicted = runHelper(fixture)
    expect(conflicted.status).toBe(1)
    expect(conflicted.stderr).toContain('pnpm-lock.yaml')
    expect(pnpmCalls(fixture)).toEqual([])

    write(fixture.fork, 'pnpm-lock.yaml', 'lockfileVersion: resolved\n')
    commit(fixture, fixture.fork, 'resolve lockfile')
    const resumed = runHelper(fixture)
    expect(resumed.status, resumed.stderr).toBe(0)
    expect(pnpmCalls(fixture)).toEqual(['install', 'run typecheck'])

    const validated = runHelper(fixture)
    expect(validated.status, validated.stderr).toBe(0)
    expect(pnpmCalls(fixture)).toEqual(['install', 'run typecheck', 'run typecheck'])
  })
})

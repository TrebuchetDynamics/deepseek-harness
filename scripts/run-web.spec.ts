import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repository = resolve(import.meta.dirname, '..')
const launcher = join(repository, 'run-web.sh')

function renderUnit(...args: string[]): string {
  return execFileSync(launcher, ['__render_unit', ...args], {
    cwd: repository,
    encoding: 'utf8',
  })
}

describe('run-web systemd launcher', () => {
  it('documents the persistent service lifecycle', () => {
    const help = execFileSync(launcher, ['help'], { cwd: repository, encoding: 'utf8' })

    expect(help).toContain('Install dependencies and build DeepSeek Harness')
    expect(help).toContain('reboot-persistent systemd service')
    expect(help).toContain('install')
    expect(help).toContain('uninstall')
    expect(help).toContain('/etc/dsh-web.env')
  })

  it('renders a non-root, readiness-aware service with escaped paths', () => {
    const unit = renderUnit(
      'alice',
      'developers',
      '/home/alice',
      '/opt/pnpm path/pnpm',
      '/opt/node/bin/node',
      '/opt/dsh path%/run\\web.sh',
    )

    expect(unit).toContain('PartOf=tailscaled.service')
    expect(unit).toContain('Type=notify')
    expect(unit).toContain('User=alice')
    expect(unit).toContain('Group=developers')
    expect(unit).toContain('Environment="DSH_HOME=/home/alice/.dsh"')
    expect(unit).toContain('EnvironmentFile=-/etc/dsh-web.env')
    expect(unit).toContain('ExecStart="/opt/dsh path%%/run\\\\web.sh" __service')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=multi-user.target')
  })

  it('rejects line breaks before rendering a privileged unit', () => {
    const result = spawnSync(
      launcher,
      [
        '__render_unit',
        'alice',
        'developers',
        '/home/alice',
        '/opt/pnpm',
        '/opt/node',
        '/opt/dsh/run-web.sh\nExecStart=/bin/false',
      ],
      { cwd: repository, encoding: 'utf8' },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('launcher path must not contain line breaks')
  })

  it.runIf(process.platform === 'linux' && spawnSync('systemd-analyze', ['--version']).status === 0)(
    'produces a unit accepted by systemd',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'dsh-web-unit-'))
      const user = execFileSync('id', ['-un'], { encoding: 'utf8' }).trim()
      const group = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim()
      const home = process.env.HOME ?? '/tmp'
      const pnpm = execFileSync('sh', ['-c', 'command -v pnpm'], { encoding: 'utf8' }).trim()
      const node = execFileSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim()
      const service = join(directory, 'dsh-web.service')
      const tailscaled = join(directory, 'tailscaled.service')
      writeFileSync(service, renderUnit(user, group, home, pnpm, node, launcher))
      writeFileSync(tailscaled, '[Service]\nExecStart=/bin/true\n')

      const result = spawnSync('systemd-analyze', ['verify', service, tailscaled], { encoding: 'utf8' })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
    },
  )
})

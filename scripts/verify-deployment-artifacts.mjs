/** Print artifacts missing from a source checkout after its deployment build. */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const repo = process.argv[2]
if (!repo) throw new Error('usage: verify-deployment-artifacts.mjs <repository>')

const missing = []
if (!existsSync(join(repo, 'node_modules'))) missing.push('node_modules')
if (!existsSync(join(repo, 'apps/web/dist/index.html'))) {
  missing.push('apps/web/dist/index.html')
}
for (const directory of readdirSync(join(repo, 'packages/client'))) {
  const packageDirectory = join(repo, 'packages/client', directory)
  const manifestPath = join(packageDirectory, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (
    manifest.dsh?.client &&
    !existsSync(join(packageDirectory, 'lib/client.js'))
  ) {
    missing.push(`${directory}/lib/client.js`)
  }
}
process.stdout.write(missing.join(', '))

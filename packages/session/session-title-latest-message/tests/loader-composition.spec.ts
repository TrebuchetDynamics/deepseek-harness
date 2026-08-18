import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as providerPlugin from '@deepseek-ai/dsh-session-title-latest-message'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-title-latest-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-title'",
    '  config:',
    '    fallbackMaxWords: 5',
    '    fallbackMaxBytes: 40',
    '    maxTitleBytes: 80',
    "- name: '@deepseek-ai/dsh-session-title-latest-message'",
    '  config:',
    '    maxWords: 5',
    '    maxBytes: 40',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-title', SessionTitleService],
    ['@deepseek-ai/dsh-session-title-latest-message', providerPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('session-title-latest-message Loader composition', () => {
  it('renames the session after each composed human prompt', async () => {
    const ctx = await loadComposition()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const session = ctx.sessions.create(SessionId('loader-latest-title'))
    session.append('turn/start', { turn: 1 })
    const first = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Refactor the parser module' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: { provider: 'main-route', model: 'main-model' } },
      reason: 'initial',
    })
    await settle()

    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'Refactor the parser module',
      messageSeqs: [first.seq],
      source: { kind: 'provider', provider: 'session-title-latest-message' },
    })

    const second = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Now update the tests' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: { provider: 'main-route', model: 'main-model' } },
      reason: 'change',
    })
    await settle()

    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'Now update the tests',
      messageSeqs: [second.seq],
    })
    const titles = session.events.filter(event => event.type === 'session/title')
    expect(titles.length).toBeGreaterThanOrEqual(2)
  })
})

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService, { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type { SessionTitleProvider, SessionTitleProviderRequest } from '@deepseek-ai/dsh-session-title'
import * as providerPlugin from '@deepseek-ai/dsh-session-title-latest-message'

const TITLE_CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } as const
const PLUGIN_CONFIG = { maxWords: 5, maxBytes: 40 } as const

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** Mount the service, capture the provider registered by `apply`, and return it. */
async function capturedProvider(): Promise<[Context, SessionTitleProvider]> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionTitleService, TITLE_CONFIG)
  let registered: SessionTitleProvider | undefined
  vi.spyOn(ctx.sessionTitle, 'register').mockImplementation((provider) => {
    registered = provider
    return async () => undefined
  })
  providerPlugin.apply(ctx, PLUGIN_CONFIG)
  if (registered === undefined) throw new Error('provider was not registered')
  return [ctx, registered]
}

function generateRequest(messages: SessionTitleProviderRequest['messages']): SessionTitleProviderRequest {
  return {
    session: Session.create(SessionId('detached-title')),
    messages,
    signal: new AbortController().signal,
  }
}

describe('latest-message title provider', () => {
  it('registers a deterministic all-prompts provider with a branded id', async () => {
    const [, provider] = await capturedProvider()
    expect(provider.id).toBe('session-title-latest-message')
    expect(provider.automatic).toBe('all-prompts')
  })

  it('removes its provider registration when the plugin fiber unloads (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    const fiber = await ctx.plugin(providerPlugin, PLUGIN_CONFIG)
    const replacement: SessionTitleProvider = {
      id: SessionTitleProviderId('replacement'),
      automatic: 'first-prompt',
      generate: async request => ({ title: 'replacement', messageSeqs: [request.messages[0]!.seq] }),
    }
    expect(() => ctx.sessionTitle.register(replacement)).toThrow(/already registered/)

    await fiber.dispose()

    const disposeReplacement = ctx.sessionTitle.register(replacement)
    await disposeReplacement()
  })

  it('derives the title from the newest eligible message only', async () => {
    const [, provider] = await capturedProvider()
    const result = await provider.generate(generateRequest([
      { seq: SessionSeq(1), text: 'first prompt about parsing' },
      { seq: SessionSeq(2), text: 'second prompt about rendering' },
    ]))
    expect(result).toEqual({
      title: 'second prompt about rendering',
      messageSeqs: [2],
    })
  })

  it('rejects an empty message request at its own boundary', async () => {
    const [, provider] = await capturedProvider()
    await expect(provider.generate(generateRequest([]))).rejects.toThrow(/at least one eligible human message/)
  })

  it('honors caller cancellation before deriving', async () => {
    const [, provider] = await capturedProvider()
    const controller = new AbortController()
    controller.abort()
    await expect(provider.generate({
      session: Session.create(SessionId('detached-title')),
      messages: [{ seq: SessionSeq(1), text: 'never titled' }],
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('applies the configured word cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    let registered: SessionTitleProvider | undefined
    vi.spyOn(ctx.sessionTitle, 'register').mockImplementation((provider) => {
      registered = provider
      return async () => undefined
    })
    providerPlugin.apply(ctx, { maxWords: 2, maxBytes: 100 })
    const result = await registered!.generate(generateRequest([
      { seq: SessionSeq(1), text: 'one two three four five' },
    ]))
    expect(result.title).toBe('one two')
  })

  it('applies the UTF-8 byte cap without splitting a code point', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    let registered: SessionTitleProvider | undefined
    vi.spyOn(ctx.sessionTitle, 'register').mockImplementation((provider) => {
      registered = provider
      return async () => undefined
    })
    providerPlugin.apply(ctx, { maxWords: 5, maxBytes: 3 })
    const result = await registered!.generate(generateRequest([
      { seq: SessionSeq(1), text: 'héllo world' },
    ]))
    expect(result.title).toBe('hé')
  })

  it('rejects an over-tight byte cap that empties the derived title', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    let registered: SessionTitleProvider | undefined
    vi.spyOn(ctx.sessionTitle, 'register').mockImplementation((provider) => {
      registered = provider
      return async () => undefined
    })
    providerPlugin.apply(ctx, { maxWords: 5, maxBytes: 1 })
    await expect(registered!.generate(generateRequest([
      { seq: SessionSeq(1), text: '你' },
    ]))).rejects.toThrow(/produced an empty title/)
  })

  it('rejects invalid configuration at apply time', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    vi.spyOn(ctx.sessionTitle, 'register').mockReturnValue(async () => undefined)
    expect(() => { providerPlugin.apply(ctx, { maxWords: 5, maxBytes: 0 }) })
      .toThrow('maxBytes must be a positive integer')
    expect(() => { providerPlugin.apply(ctx, { maxWords: 0, maxBytes: 40 }) })
      .toThrow('maxWords must be a positive integer')
    expect(() => { providerPlugin.apply(ctx, { maxWords: 1.5, maxBytes: 40 }) })
      .toThrow('maxWords must be a positive integer')
    expect(() => { providerPlugin.apply(ctx, { maxWords: 5, maxBytes: 40, extra: true } as never) })
      .toThrow('unknown config key "extra"')
    expect(() => { providerPlugin.apply(ctx, null as never) })
      .toThrow('configuration is required')
  })

  it('renames the session again after every new human message', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SessionTitleService, TITLE_CONFIG)
    await ctx.plugin(providerPlugin, PLUGIN_CONFIG)
    const session = ctx.sessions.create(SessionId('rename-cadence'))
    session.append('turn/start', { turn: 1 })
    const first = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'first prompt about parsing' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: { provider: 'main', model: 'main-model' } }, reason: 'initial',
    })
    await settle()
    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'first prompt about parsing',
      messageSeqs: [first.seq],
      source: { kind: 'provider', provider: 'session-title-latest-message' },
    })

    const second = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second prompt about rendering' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('request/header', {
      header: { config: { provider: 'main', model: 'main-model' } }, reason: 'change',
    })
    await settle()

    expect(ctx.sessionTitle.get(session)).toMatchObject({
      title: 'second prompt about rendering',
      messageSeqs: [second.seq],
    })
    const titles = session.snapshotEvents().filter(event => event.type === 'session/title')
    expect(titles.length).toBeGreaterThanOrEqual(2)
  })
})

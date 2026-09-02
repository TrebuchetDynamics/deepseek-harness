import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import UserQuestionService, {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

interface QuestionAnswerer {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

function registerAnswerer(ctx: Context, answerer: QuestionAnswerer): () => void {
  return ctx.on('user-questions/request', request => answerer.ask(request))
}

function provider(answer = 'approved'): QuestionAnswerer & { seen: AskUserQuestionRequest[] } {
  const seen: AskUserQuestionRequest[] = []
  return {
    seen,
    async ask(request) {
      seen.push(request)
      return {
        answers: request.questions.map(question => ({ id: question.id, selected: [answer] })),
      }
    },
  }
}

function stubAgent(id: string, delegationDepth = 0): Agent {
  const agentId = id as Agent['id']
  return {
    id: agentId,
    session: { id: agentId, header: { delegationDepth } },
  } as unknown as Agent
}

function inboxMessage(kind: 'user' | 'plugin') {
  return createUserMessage({
    content: [{ type: 'text', text: 'next prompt' }],
    source: kind === 'user' ? { kind } : { kind, plugin: 'test' },
  })
}

describe('UserQuestionService', () => {
  it('delegates ask requests to the registered provider', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider('yes')
    registerAnswerer(ctx, p)
    const questions = [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'yes' }] }]

    const result = await ctx.userQuestions.ask({ questions })

    expect(result).toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
    expect(p.seen).toEqual([{ questions }])
  })

  it('rejects ask requests when no provider is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'NO_PROVIDER' })
  })

  it('registers providers with HMR-safe disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider()
    const dispose = registerAnswerer(ctx, p)

    dispose()
    dispose()

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }] }))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
  })

  it('delegates through composed answerers', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const delegated = vi.fn()
    ctx.on('user-questions/request', (_request, next) => {
      delegated()
      return next()
    })
    const p = provider('second')
    registerAnswerer(ctx, p)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'second' }] }],
    })).resolves.toEqual({ answers: [{ id: 'confirm', selected: ['second'] }] })
    expect(delegated).toHaveBeenCalledOnce()
  })

  it('fails before reaching the provider when the signal is already aborted', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [{ id: 'confirm', selected: ['too late'] }] })) }
    registerAnswerer(ctx, p)
    const controller = new AbortController()
    controller.abort()

    await expect(ctx.userQuestions.ask({ questions: [{ id: 'confirm', question: 'Proceed?' }], signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ASK_ABORTED' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('normalizes an in-flight signal cancellation to ASK_ABORTED', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const pending = Promise.withResolvers<never>()
    registerAnswerer(ctx, { ask: () => pending.promise })
    const controller = new AbortController()
    const abortReason = new DOMException('This operation was aborted', 'AbortError')

    const answer = ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      signal: controller.signal,
    })
    controller.abort(abortReason)
    pending.reject(abortReason)

    await expect(answer).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'ASK_ABORTED',
      cause: abortReason,
    })
  })

  it('preserves a domain rejection when its provider also aborts the signal', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const controller = new AbortController()
    const cancelled = new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')
    registerAnswerer(ctx, {
      ask: () => {
        controller.abort()
        return Promise.reject(cancelled)
      },
    })

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      signal: controller.signal,
    })).rejects.toBe(cancelled)
  })

  it('restores a transported provider rejection to UserQuestionError', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const transported = Object.assign(new Error('the user cancelled ask_user_question'), {
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
    })
    registerAnswerer(ctx, { ask: () => Promise.reject(transported) })

    const rejection = await ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(rejection).toBeInstanceOf(UserQuestionError)
    expect(rejection).toMatchObject({
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
      cause: transported,
    })
  })

  it.each([
    ['an ordinary Error', new Error('provider failed')],
    ['a namesake Error without a string code', Object.assign(new Error('provider failed'), {
      name: 'UserQuestionError',
    })],
    ['a non-Error rejection', { name: 'UserQuestionError', code: 'ASK_CANCELLED' }],
  ])('preserves %s from the provider', async (_label, rejection) => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    registerAnswerer(ctx, { ask: vi.fn().mockRejectedValue(rejection) })

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    })).rejects.toBe(rejection)
  })

  it('rejects empty question batches before reaching the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)

    await expect(ctx.userQuestions.ask({ questions: [] }))
      .rejects.toMatchObject({ name: 'UserQuestionError', code: 'EMPTY_QUESTIONS' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a live runtime-owned agent before reaching the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)
    const root = stubAgent('root', 0)
    const child = stubAgent('child', 0)
    ctx.agents.enter(root, undefined)
    ctx.agents.enter(child, root)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: child,
    })).rejects.toMatchObject({
      name: 'UserQuestionError',
      code: 'DELEGATED_CALLER',
      message: "human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result",
    })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('reaches the provider for a lineage-bearing session resumed as a runtime root', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = provider('yes')
    registerAnswerer(ctx, p)
    const agent = stubAgent('resumed-root', 1)
    ctx.agents.enter(agent, undefined)

    const result = await ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?', options: [{ label: 'yes' }] }],
      agent,
    })

    expect(result).toEqual({ answers: [{ id: 'confirm', selected: ['yes'] }] })
  })

  it('cancels every pending ask for the exact agent when an admitted user prompt enters its inbox', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const agent = stubAgent('asked')
    const other = stubAgent('other')
    ctx.agents.enter(agent, undefined)
    ctx.agents.enter(other, undefined)
    const requests: AskUserQuestionRequest[] = []
    registerAnswerer(ctx, {
      ask(request) {
        requests.push(request)
        return new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const reason: unknown = request.signal?.reason as unknown
            reject(reason instanceof Error ? reason : new Error('question aborted', { cause: reason }))
          }, { once: true })
        })
      },
    })

    const first = ctx.userQuestions.ask({ questions: [{ id: 'first', question: 'First?' }], agent })
    const second = ctx.userQuestions.ask({ questions: [{ id: 'second', question: 'Second?' }], agent })
    const untouched = ctx.userQuestions.ask({ questions: [{ id: 'other', question: 'Other?' }], agent: other })
    await vi.waitFor(() => { expect(requests).toHaveLength(3) })

    ctx.emit('agent/inbox/inserted', { agent, message: inboxMessage('user') })

    await expect(first).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    await expect(second).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    expect(requests[2]?.signal?.aborted).toBe(false)
    ctx.emit('agent/inbox/inserted', { agent: other, message: inboxMessage('user') })
    await expect(untouched).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('does not cancel for a non-user insertion, a rejected prompt with no insertion, or another agent', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const agent = stubAgent('asked')
    const other = stubAgent('other')
    ctx.agents.enter(agent, undefined)
    ctx.agents.enter(other, undefined)
    const completion = Promise.withResolvers<AskUserQuestionAnswer>()
    let request: AskUserQuestionRequest | undefined
    registerAnswerer(ctx, { ask: (value) => { request = value; return completion.promise } })
    const answer = ctx.userQuestions.ask({ questions: [{ id: 'choice', question: 'Choose?' }], agent })
    await vi.waitFor(() => { expect(request).toBeDefined() })

    ctx.emit('agent/inbox/inserted', { agent, message: inboxMessage('plugin') })
    ctx.emit('agent/inbox/inserted', { agent: other, message: inboxMessage('user') })
    // A Host-rejected prompt never enters the Agent inbox, so it emits no insertion.
    expect(request?.signal?.aborted).toBe(false)

    const value = { answers: [{ id: 'choice', selected: ['keep waiting'] }] }
    completion.resolve(value)
    await expect(answer).resolves.toEqual(value)
  })

  it('does not let a provider answer win after a user prompt supersedes the ask', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const agent = stubAgent('asked')
    ctx.agents.enter(agent, undefined)
    const completion = Promise.withResolvers<AskUserQuestionAnswer>()
    registerAnswerer(ctx, { ask: () => completion.promise })
    const answer = ctx.userQuestions.ask({ questions: [{ id: 'choice', question: 'Choose?' }], agent })
    await Promise.resolve()

    ctx.emit('agent/inbox/inserted', { agent, message: inboxMessage('user') })
    completion.resolve({ answers: [{ id: 'choice', selected: ['late'] }] })

    await expect(answer).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  })

  it('removes settled asks and the inbox listener with their owners', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = ctx.plugin(UserQuestionService)
    await fiber
    const service = ctx.userQuestions
    const agent = stubAgent('asked')
    ctx.agents.enter(agent, undefined)
    const completions: Array<PromiseWithResolvers<AskUserQuestionAnswer>> = []
    const requests: AskUserQuestionRequest[] = []
    registerAnswerer(ctx, {
      ask(request) {
        requests.push(request)
        const completion = Promise.withResolvers<AskUserQuestionAnswer>()
        completions.push(completion)
        return completion.promise
      },
    })

    const settled = service.ask({ questions: [{ id: 'done', question: 'Done?' }], agent })
    await vi.waitFor(() => { expect(completions).toHaveLength(1) })
    completions[0]?.resolve({ answers: [{ id: 'done', selected: ['yes'] }] })
    await settled
    ctx.emit('agent/inbox/inserted', { agent, message: inboxMessage('user') })
    expect(requests[0]?.signal?.aborted).toBe(false)

    const pending = service.ask({ questions: [{ id: 'pending', question: 'Pending?' }], agent })
    await vi.waitFor(() => { expect(completions).toHaveLength(2) })
    await fiber.dispose()
    ctx.emit('agent/inbox/inserted', { agent, message: inboxMessage('user') })
    expect(requests[1]?.signal?.aborted).toBe(false)
    completions[1]?.resolve({ answers: [{ id: 'pending', selected: ['after disposal'] }] })
    await expect(pending).resolves.toMatchObject({ answers: [{ id: 'pending' }] })
  })

  it('rejects a supplied agent when no live registry can attest it', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: stubAgent('unattested'),
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'CALLER_NOT_LIVE' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a stale agent object that reuses a live id', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)
    const live = stubAgent('same-id')
    ctx.agents.enter(live, undefined)

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
      agent: stubAgent('same-id'),
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'CALLER_NOT_LIVE' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('restores a transported UserQuestionError to the public error class', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const transported = Object.assign(new Error('the user cancelled ask_user_question'), {
      name: 'UserQuestionError',
      code: 'ASK_CANCELLED',
    })
    registerAnswerer(ctx, { ask: () => Promise.reject(transported) })

    const failure = await ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    }).then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(UserQuestionError)
    expect(failure).toMatchObject({
      name: 'UserQuestionError', code: 'ASK_CANCELLED', cause: transported,
    })
  })

  it('preserves a provider rejection outside the UserQuestionError taxonomy', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const failure = new Error('provider failed')
    registerAnswerer(ctx, { ask: () => Promise.reject(failure) })

    await expect(ctx.userQuestions.ask({
      questions: [{ id: 'confirm', question: 'Proceed?' }],
    })).rejects.toBe(failure)
  })

  it('rejects an intent whose approve label names none of its own options', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)
    const question = { id: 'plan-review', question: 'Approve?', detail: '# Plan' }

    // A wrong label among offered options, and no options offered at all.
    for (const options of [[{ label: 'Approve' }], undefined]) {
      await expect(ctx.userQuestions.ask({
        questions: [{
          ...question,
          ...(options === undefined ? {} : { options }),
          intent: { kind: 'plan-review', approve: 'Ship it' },
        }],
      })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'BAD_INTENT' })
    }
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('rejects a plan-review intent on a question carrying no plan to review', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = { ask: vi.fn(async () => ({ answers: [] })) }
    registerAnswerer(ctx, p)

    // Detail IS the plan for this intent, so a UI honouring it would ask the
    // user to approve something they cannot see.
    await expect(ctx.userQuestions.ask({
      questions: [{
        id: 'plan-review', question: 'Approve?',
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review', approve: 'Approve' },
      }],
    })).rejects.toMatchObject({ name: 'UserQuestionError', code: 'BAD_INTENT' })
    expect(p.ask).not.toHaveBeenCalled()
  })

  it('passes an intent through once its approve label names an offered option', async () => {
    const ctx = new Context()
    await ctx.plugin(UserQuestionService)
    const p = provider('Approve')
    registerAnswerer(ctx, p)
    const intent = { kind: 'plan-review', approve: 'Approve' } as const

    const result = await ctx.userQuestions.ask({
      questions: [
        { id: 'plain', question: 'Proceed?', options: [{ label: 'Approve' }] },
        {
          id: 'plan-review', question: 'Approve?', detail: '# Plan',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }], intent,
        },
      ],
    })

    expect(result.answers).toEqual([
      { id: 'plain', selected: ['Approve'] },
      { id: 'plan-review', selected: ['Approve'] },
    ])
    expect(p.seen[0]?.questions[1]?.intent).toEqual(intent)
  })
})

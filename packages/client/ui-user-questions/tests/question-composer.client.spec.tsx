// @vitest-environment jsdom
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { QuestionComposer } from '../src/client/QuestionComposer.tsx'
import { PendingQuestion, type QuestionComposerProps } from '../src/client/contract/slots.ts'
import { createQuestionDraftStore } from '../src/client/draft-store.ts'

afterEach(cleanup)

const SESSION_ID = 'single-choice' as SessionId

describe('QuestionComposer', () => {
  it('submits an only single-choice question immediately when its option is selected', () => {
    const pending = new PendingQuestion(SESSION_ID, [{
      id: 'identity',
      question: 'Choose the next identity',
      options: [
        { label: 'Authorize fresh R6 (Recommended)' },
        { label: 'Stop the campaign' },
      ],
    }])
    void pending.result.catch(() => undefined)
    const answer = vi.spyOn(pending, 'answer')
    const store = createQuestionDraftStore().create(SESSION_ID)
    const props = {
      matched: pending,
      t: (key: string) => key,
      useStore: (selector: (state: ReturnType<typeof store.getSnapshot>) => unknown) => useSyncExternalStore(
        listener => store.subscribe(listener),
        () => selector(store.getSnapshot()),
        () => selector(store.getSnapshot()),
      ),
      actions: store.actions,
    } as unknown as QuestionComposerProps
    render(<QuestionComposer {...props} />)

    fireEvent.click(screen.getByRole('radio', { name: 'Authorize fresh R6' }))

    expect(answer).toHaveBeenCalledOnce()
    expect(answer).toHaveBeenCalledWith({
      answers: [{ id: 'identity', selected: ['Authorize fresh R6 (Recommended)'] }],
    })
  })
})

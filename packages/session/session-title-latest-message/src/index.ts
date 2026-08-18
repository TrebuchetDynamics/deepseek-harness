/**
 * Deterministic session-title provider: renames a session to the leading words
 * of its newest eligible human message after every prompt.
 * @module @deepseek-ai/dsh-session-title-latest-message
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  fallbackSessionTitle,
  SessionTitleProviderId,
} from '@deepseek-ai/dsh-session-title'
import type {
  SessionTitleProviderRequest,
  SessionTitleProviderResult,
} from '@deepseek-ai/dsh-session-title'

export const name = 'session-title-latest-message'
export const inject = ['sessionTitle', 'sessions']

/** Required word and byte limits for the deterministic latest-message title. */
export interface Config {
  /** Maximum whitespace-delimited words taken from the newest message. */
  readonly maxWords: number
  /** Maximum UTF-8 bytes in the derived title. */
  readonly maxBytes: number
}

/** Loader schema with no library defaults. */
/* jscpd:ignore-start -- Loader requires each plugin to export its own statically walkable schema. */
export const Config: z<Config> = z.object({
  maxWords: z.number().step(1).min(1).required(),
  maxBytes: z.number().step(1).min(1).required(),
})
/* jscpd:ignore-end */

/** Complete config-key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set(['maxWords', 'maxBytes'])

/** Validate one positive integer limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-latest-message: ${name} must be a positive integer`)
  }
}

/**
 * Validate and detach required plugin configuration.
 * @param config - untrusted plugin configuration.
 * @returns one immutable copy of the validated limits.
 */
function resolveConfig(config: Config): Readonly<Config> {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-title-latest-message: configuration is required')
  }
  const value = candidate as Config
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`session-title-latest-message: unknown config key "${key}"`)
    }
  }
  assertPositiveInteger('maxWords', value.maxWords)
  assertPositiveInteger('maxBytes', value.maxBytes)
  return { maxWords: value.maxWords, maxBytes: value.maxBytes }
}

/**
 * Register the deterministic latest-message `ctx.sessionTitle` provider. The
 * `all-prompts` cadence schedules a new revision after each eligible human
 * message, and the derived title tracks that newest message; a newer revision
 * aborts and supersedes older work inside the shared title service.
 * @param ctx - context exposing the session-title and session services.
 * @param config - required word and byte limits.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.sessionTitle.register({
    id: SessionTitleProviderId(name),
    automatic: 'all-prompts',
    generate(request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult> {
      if (request.signal.aborted) {
        const error = new Error('session-title-latest-message: title generation aborted')
        error.name = 'AbortError'
        return Promise.reject(error)
      }
      const latest = request.messages.at(-1)
      if (latest === undefined) {
        return Promise.reject(new Error('session-title-latest-message: at least one eligible human message is required'))
      }
      const title = fallbackSessionTitle(latest.text, resolved.maxWords, resolved.maxBytes)
      if (title.length === 0) {
        return Promise.reject(new Error('session-title-latest-message: the latest message produced an empty title'))
      }
      return Promise.resolve({ title, messageSeqs: [latest.seq] })
    },
  })
}

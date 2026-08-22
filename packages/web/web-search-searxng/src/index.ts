/**
 * `@deepseek-ai/dsh-web-search-searxng`: registers a SearXNG-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): it registers INTO the seam's provider registry, like
 * `@deepseek-ai/dsh-llm-deepseek` registers an adapter into `ctx.llm`. No API key
 * is required — SearXNG is self-hosted, so a configured `baseURL` fully determines
 * availability.
 *
 * @module @deepseek-ai/dsh-web-search-searxng
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  SearXNGSearchProvider,
  SEARXNG_DEFAULT_BASE_URL,
} from './provider.ts'

export {
  SEARXNG_DEFAULT_BASE_URL,
  SEARXNG_PROVIDER_ID,
  SearXNGSearchProvider,
} from './provider.ts'
export type { SearXNGSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-searxng'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Env var naming the SearXNG instance base URL. */
const BASE_URL_ENV = 'SEARXNG_BASE_URL'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** SearXNG instance base URL; `/search?format=json` is appended. Required to be usable. */
  baseURL?: string
  /** Optional comma-separated engine set (SearXNG `engines`). */
  engines?: string
  /** Optional language/region, e.g. `en-US`. */
  language?: string
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
  engines: z.string(),
  language: z.string(),
})

/** Register the SearXNG search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new SearXNGSearchProvider({
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(BASE_URL_ENV)?.value
      ?? SEARXNG_DEFAULT_BASE_URL,
    ...config.engines !== undefined && config.engines.length > 0 ? { engines: config.engines } : {},
    ...config.language !== undefined && config.language.length > 0 ? { language: config.language } : {},
  }))
}

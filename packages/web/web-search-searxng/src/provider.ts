/**
 * `SearXNGSearchProvider`: a `WebSearchProvider` backed by a SearXNG/SearX
 * aggregation instance (`GET /search?q=…&format=json`). It is KEYLESS by design:
 * SearXNG is self-hosted and needs no external API key, which is what makes it a
 * viable "completely free" web-search route in a harness whose shipped providers
 * (DeepSeek-official, Exa, Perplexity) are all paid or key-gated.  The provider
 * maps the flat `results[]` into the seam's normalized `WebSearchResult`, using
 * `content` as the snippet.
 * @module @deepseek-ai/dsh-web-search-searxng/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { SearXNGError, SearXNGResult, SearXNGSearchResponse } from './types.ts'

/** Stable id this provider registers under. */
export const SEARXNG_PROVIDER_ID = 'searxng'

/**
 * Default SearXNG endpoint base; `/search?format=json` is appended. Not a real
 * default to ship behind — the operator MUST set `baseURL` to a hosted instance
 * they control (or trust). A self-hosted instance is the intended target; a
 * public aggregator may rate-limit or block automated JSON queries.
 */
export const SEARXNG_DEFAULT_BASE_URL = 'https://search.example.invalid'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env and constant defaults). */
export interface SearXNGSearchProviderOptions {
  /** SearXNG instance base URL; `/search?format=json` is appended. Must parse. */
  baseURL: string
  /** Optional comma-separated engine set (SearXNG `engines`). Blank = instance defaults. */
  engines?: string
  /** Optional language/region, e.g. `en-US` (SearXNG `language`). */
  language?: string
  /** Optional request timeout ms. Defaults to the caller's tool budget. */
  timeoutMs?: number
}

/**
 * Map one SearXNG result to a normalized source. A result with no URL is dropped
 * (the seam cannot cite a source without one); title/snippet/date fall back to
 * the engine's omissions rather than being invented.
 *
 * @param result - one entry of SearXNG's `results[]`.
 * @returns the normalized source, or `undefined` when the URL is blank.
 */
export function mapSearXNGResult(result: SearXNGResult): WebSearchSource | undefined {
  if (result.url === undefined || result.url.trim().length === 0) return undefined
  const snippet = result.content?.trim()
  return {
    url: result.url,
    ...result.title != null && result.title.trim().length > 0 ? { title: result.title } : {},
    ...snippet !== undefined && snippet.length > 0 ? { snippet } : {},
    ...result.publishedDate != null && result.publishedDate.length > 0
      ? { publishedAt: result.publishedDate }
      : {},
  }
}

/**
 * Map a SearXNG JSON response envelope to a normalized search result.
 *
 * @param response - the parsed `GET /search?format=json` response body.
 * @returns the normalized result; unusable entries are dropped ({@link mapSearXNGResult}).
 */
export function mapSearXNGResponse(response: SearXNGSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapSearXNGResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // SearXNG returns no generated answer, so `content` is omitted. The web service
  // owns final `maxResults` truncation, so this provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** The SearXNG-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class SearXNGSearchProvider implements WebSearchProvider {
  readonly id = SEARXNG_PROVIDER_ID

  constructor(private readonly options: SearXNGSearchProviderOptions) {}

  available(): boolean {
    // Available only when a REAL endpoint is configured: parseable AND not the
    // shipped placeholder. No key — availability does not depend on a credential
    // existing, but pointing at search.example.invalid must read as
    // "not configured", not "available but broken".
    const { baseURL } = this.options
    return URL.canParse(baseURL) && baseURL !== SEARXNG_DEFAULT_BASE_URL
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const url = new URL(`${this.options.baseURL}/search`)
    url.searchParams.set('q', request.query)
    url.searchParams.set('format', 'json')
    if ((this.options.engines?.length ?? 0) > 0) {
      url.searchParams.set('engines', this.options.engines as string)
    }
    if ((this.options.language?.length ?? 0) > 0) {
      url.searchParams.set('language', this.options.language as string)
    }
    let response: Response
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`SearXNG search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `SearXNG search error (HTTP ${status})`
      try {
        const parsed = await response.json() as SearXNGError
        const detail = parsed.error ?? parsed.message
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
        // A non-JSON error body (gateway 5xx/429) only costs richer detail.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as SearXNGSearchResponse
      return mapSearXNGResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('SearXNG search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(
        `SearXNG returned an unprocessable response body: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

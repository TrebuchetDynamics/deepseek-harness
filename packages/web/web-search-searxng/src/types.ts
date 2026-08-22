/**
 * Wire types for a SearXNG/SearX JSON search API (`GET /search?q=…&format=json`).
 * Types only — no runtime code. A self-hosted SearXNG aggregator returns a flat
 * `results[]`; each entry carries a URL, an optional title, an optional `content`
 * snippet, an optional ISO date, and the engines that produced it.
 *
 * @module @deepseek-ai/dsh-web-search-searxng/types
 */

/** One entry of SearXNG's flat `results[]`. */
export interface SearXNGResult {
  url?: string
  title?: string | null
  /** Reconstructed full-text or engine snippet; mapped to `snippet`. */
  content?: string | null
  publishedDate?: string | null
  /** Engines that produced this result (informational; not surfaced). */
  engines?: string[]
  category?: string[]
}

/** SearXNG's JSON response envelope. */
export interface SearXNGSearchResponse {
  query?: string
  number_of_results?: number
  results?: SearXNGResult[]
}

/** SearXNG error envelope (best-effort; fields vary by deployment). */
export interface SearXNGError {
  error?: string
  message?: string
}

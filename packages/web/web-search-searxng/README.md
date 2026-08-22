# @deepseek-ai/dsh-web-search-searxng

English | [中文](README.zh.md)

A [SearXNG](https://docs.searxng.org)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls a SearXNG/SearX instance's JSON search endpoint (`GET /search?q=…&format=json`) and maps the aggregator's flat `results[]` into the seam's normalized `WebSearchResult`.

**SearXNG is a self-hosted, keyless meta-search aggregator** — it queries upstream engines (Google, Bing, DuckDuckGo, Mojeek, Brave, and more) from ITS OWN host/IP and returns a combined JSON feed. This is what makes it a viable *completely free* web-search route for a harness whose three built-in providers (`deepseek-official`, `exa`, `perplexity`) are all paid or key-gated: no API key, no account, and the anti-bot IP-reputation that blocks datacenter-harbored scrapers applies to the SearXNG host, not to your harness process.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL` (else unreachable placeholder) | SearXNG instance base URL; `/search?format=json` is appended. **You must point this at a hosted instance you control or trust.** An unparseable value makes the provider unavailable. |
| `engines` | (unset) | Optional comma-separated engine set passed as SearXNG's `engines`. Blank sends none (instance defaults). |
| `language` | (unset) | Optional language/region (e.g. `en-US`) passed as SearXNG's `language`. |

```yaml
- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: !!js process.env.SEARXNG_BASE_URL
```

## Mapping

SearXNG returns a flat `results[]` and no generated answer, so `content` is omitted (the model-facing tool renders the optional answer + source list). Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← `content`, `publishedAt` ← `publishedDate`. A result with no usable `url` is dropped; an empty `title`/`content`/date are omitted rather than invented. The final source bound is enforced by the web seam. Provider failures surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`; HTTP redirects are rejected before the `Location` target is contacted.

## Model Experience

Indirectly, through [tool-web](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, snippets, and publication dates, or its exact `SearXNG search aborted`, `SearXNG search request failed: <error>`, `SearXNG search error (HTTP <status>)`, and `SearXNG returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

## Known Limitations and Deferred Work

- **SearXNG outputs vary by instance config** — the JSON result shape is standard, but the set of populated fields and the engines that feed it depend on the deployment's `SEARXNG_ENGINES`. Expect sparse `title`/`content` fields when an upstream engine returns title-only results.
- **Public SearXNG instances often rate-limit or block automated JSON** (observed: HTTP 403/429 on several public instances). **Host your own** (compose/docker is a few minutes) for reliability.
- **No caching / no per-engine tuning** — SearXNG's `format`, `categories`, and `time_range` controls wait on provider-neutral Service Definition fields.
- **Generic bot-reputation is not removable** — the aggregator still depends on the upstream engines tolerating its queries.

## Not intended for

- **Private/sensitive traffic** — SearXNG forwards your query to third-party search engines; do not use it for searches whose content must not reach an upstream engine host. This is a public-web search provider.
- **Replacing the paid providers** in deployments that need server-side retrieval with an AI answer — SearXNG returns structured links, not a generated answer.

# Agent Note: Authenticated reverse proxies can expose settings to their owner

Status: implemented

English | [中文](2026-08-20-authenticated-remote-settings.zh.md)

## Problem

The browser settings layer classified every non-loopback URL as permanently unavailable and never called `settings.describe`. This duplicated the Host authorization decision in presentation code: an authenticated reverse proxy could present an approved loopback authority to the Host, but the Models page still failed with `settings are unavailable in this browser`. The Docker Tailscale proxy already authorized owner-only settings and credential methods, yet its provider-directory request also missed the owner-only matcher.

## Decision

Browser settings always use the Host transport. The Host remains the authorization authority: ordinary remote requests are rejected there, while an authenticated reverse proxy may rewrite `Host` and `Origin` only for its identified owner. The Tailscale Caddy matcher includes both `settings.*` and `llm.providers`, so the Models page can load its shared settings document and provider directory through the same owner check.

The explicit in-memory mode remains available to embedded consumers and tests, but URL classification no longer selects it in production.

## Alternatives considered

**Keep the client-side remote block and add a proxy capability flag.** Rejected: the flag would add a second authorization signal and protocol solely to decide whether the browser may attempt an RPC. It could not grant access because the Host must still authorize every request.

**Expose settings to every trusted host.** Rejected: trusted hosts prevent DNS rebinding and cross-site requests; they do not authenticate a user. The proxy must authenticate the Tailscale identity before rewriting the authority.

## Consequences

Authenticated Tailscale owners can load Models and other durable settings pages. Unauthenticated remote browsers issue a settings read that the Host rejects instead of being disabled before the request. Focused client tests cover remote mirror and scope activation; a live headless Chromium run through Tailscale Serve observed successful `settings.describe` and `llm.providers` responses and rendered the Models provider cards.

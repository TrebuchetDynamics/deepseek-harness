# Agent Note: Authenticated reverse proxies can expose settings to their owner

Status: implemented

English | [中文](2026-08-20-authenticated-remote-settings.zh.md)

## Problem

The browser settings layer classified every non-loopback URL as permanently unavailable and never called `settings.describe`. This duplicated the Host authorization decision in presentation code: an authenticated reverse proxy could present an approved loopback authority to the Host, but the Models page still failed with `settings are unavailable in this browser`. Owner-only plugin routes have the same integration requirement: Task Board deliberately rejects an ordinary trusted Host and requires an allowlisted proxy authority plus a private token. Remote SSH independently requires a loopback socket, Host, and browser origin markers, so its API and terminal reject even the authenticated owner unless the proxy translates that authority.

## Decision

Browser settings always use the Host transport. The Host remains the authorization authority: ordinary remote requests are rejected there, while an authenticated reverse proxy may rewrite `Host` and `Origin` only for its identified owner. The Tailscale Caddy matcher includes the configuration methods and owner-only plugin routes that the remote GUI uses. Remote SSH HTTP and WebSocket requests receive the loopback Host and Origin translation only after the matcher verifies `TAILSCALE_OWNER`; other identities keep the public authority and fail the plugin's loopback fence.

Task Board retains its own proxy fence instead of receiving a loopback rewrite. The launcher generates a fresh random token, shares it only with the Host and Caddy containers, and Caddy injects it after matching `TAILSCALE_OWNER`; the fallback proxy strips any client-supplied copy. Caddy preserves the browser authority and request markers; in particular, it does not synthesize an empty `Origin` on same-origin GET requests, whose browser proof is `Sec-Fetch-Site: same-origin`.

The explicit in-memory mode remains available to embedded consumers and tests, but URL classification no longer selects it in production.

## Alternatives considered

**Keep the client-side remote block and add a proxy capability flag.** Rejected: the flag would add a second authorization signal and protocol solely to decide whether the browser may attempt an RPC. It could not grant access because the Host must still authorize every request.

**Expose owner controls to every trusted host.** Rejected: trusted hosts prevent DNS rebinding and cross-site requests; they do not authenticate a user. The proxy authenticates the Tailscale identity before rewriting a loopback-only authority or injecting a route-specific token.

**Rewrite Task Board requests as loopback.** Rejected: this would bypass the plugin's explicit proxy-host and token checks. Preserving its public authority keeps both the Caddy owner check and the plugin's independent fence effective.

## Consequences

Authenticated Tailscale owners can load Models, durable settings pages, Remote SSH, and explicitly integrated owner controls. Other tailnet identities retain the Host's remote denial because Caddy neither rewrites their authority nor supplies private route credentials. Focused client tests cover remote mirror and scope activation; live Playwright checks through Tailscale Serve cover settings reads and Task Board state, event, create, filter, move, and delete operations.

# Agent Note: Deterministic per-message session titles

Status: implemented

English | [中文](2026-08-18-session-title-latest-message-plugin.zh.md)

## Problem

The shipped default title strategy (`@deepseek-ai/dsh-session-title-first-prompt-llm`) titles a session once after its first prompt, through an auxiliary LLM call. The product wants a session that renames after every user message, deterministically, with no auxiliary request, so the session name always reflects the newest message.

## Decision

New plugin `@deepseek-ai/dsh-session-title-latest-message` registers the sole `ctx.sessionTitle` provider with the `all-prompts` cadence. `generate()` returns the newest eligible human message's leading words, using the same cleaning, word cap, and UTF-8-safe truncation as the built-in fallback, and attributes the title to that message's exact seq. Because the title service accepts exactly one provider, the base bundle's default title row swaps from the first-prompt LLM provider to this plugin; deployments that prefer LLM-backed titles patch the row's provider back (or mount `dsh-session-title-all-prompts-llm` directly).

Automatic work still starts only when the message's main request header is logged, so the rename lands just as the agent processes the message; newer revisions abort and supersede older work inside the service. The rename costs only the log-only `session/title` event.

## Alternatives considered

**Mount `@deepseek-ai/dsh-session-title-all-prompts-llm` instead.** Rejected: it costs one auxiliary LLM request per message and produces summary titles; the requested behavior is a deterministic latest-message rename.

**Listen to `user/message` and call `sessionTitle.rename()`.** Rejected: `rename()` records a `user`-sourced title with empty `messageSeqs` and pins the session against automatic work, which misstates the derivation and bypasses the service's supersession, cancellation, and cadence machinery.

## Consequences

Every session — including child sessions — renames to the leading words of its newest eligible human message as that message's request starts. No auxiliary LLM request: the main request's token and KV-cache effects are untouched. The first-prompt and all-prompts LLM providers stay available in the repository for deployments that prefer model-generated titles.
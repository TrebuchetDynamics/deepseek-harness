# @deepseek-ai/dsh-session-title-latest-message

English | [中文](README.zh.md)

Optional `ctx.sessionTitle` provider that renames a session to the leading words of its newest eligible human message after every prompt. It registers the `all-prompts` cadence and starts a new revision after each new human prompt, including child-session prompts; a newer revision aborts and supersedes older work. The derivation is fully deterministic — no model request — so the rename only costs the log-only `session/title` event.

Only text blocks from human `user/message` events are eligible, following the service's collection rule. The title is normalized exactly like the built-in fallback: whitespace is collapsed, terminal control sequences are removed, only the first `maxWords` words are kept, and UTF-8 truncation to `maxBytes` never splits a code point. Empty and non-text prompts wait for later eligible input; the newest message always wins.

## Configuration

| Key | Contract |
|---|---|
| `maxWords` | Positive maximum whitespace-delimited words taken from the newest message. |
| `maxBytes` | Positive maximum UTF-8 bytes in the derived title. |

Both limits are required; the plugin supplies no defaults. The shared service still applies its own `maxTitleBytes` ceiling when accepting the result, so a `maxBytes` above that ceiling is truncated again there.

## Provider contract

The plugin owns no state of its own: `apply` registers one provider through `ctx.sessionTitle.register()` with `automatic: 'all-prompts'`, and `generate()` returns the newest eligible message's normalized leading words attributed to that message's exact seq. The service owns supersession, cancellation, normalization, and log acceptance. See the [session-title data structures](../../../docs/subsystems/session-title.md).

## Model Experience

### Session title state

#### What the model sees

Nothing. This provider adds no request: the derived title only becomes the log-only `session/title` event, which never enters the session surface, `deriveMessages()`, system prompt, tool schemas, or request prefix.

#### Token effect

Zero added tokens in the main agent request and no auxiliary request at all.

#### KV Cache effect

None for the main request; title events do not change its reconstructed content or cache key.

## Known Limitations and Deferred Work

- The title is the raw leading words of the newest message, not a summary: a long message yields only its opening phrase, and interleaved assistant or tool content never influences the name.
- Equality is not deduplicated: pasting the same message twice still renames the session to the same text, appending a new `session/title` event each time.
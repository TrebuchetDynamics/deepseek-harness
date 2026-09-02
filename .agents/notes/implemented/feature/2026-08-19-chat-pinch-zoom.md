# Agent Note: Pinch-to-zoom the chat transcript on mobile

Status: implemented

English | [中文](2026-08-19-chat-pinch-zoom.zh.md)

## Problem

On mobile the whole GUI sticks to the platform font size. A reader who wants a bigger or smaller chat transcript has no control: pinching zooms the entire page, panning the composer and toolbar out of view. The range the product wants to scale is only the transcript itself, not the surrounding chrome.

## Decision

The chat view binds two-finger touch gestures and ctrl+wheel zoom and applies the scale through the CSS `zoom` property of the message column, so the scrollport, recovery controls, and surrounding chrome keep their size. Touch handling measures the distance between two contacts and prevents the document default only while both contacts remain in the chat; one-finger scrolling and native page zoom elsewhere remain available. Desktop trackpads and explicit ctrl+wheel share the wheel path. The scale is read from and written to `localStorage` under `dsh:chat-font-scale`, clamped to 0.8–1.8, and surfaced as `--dsh-chat-font-scale` on the transcript scroller, which the message column inherits and maps to `zoom`. A localized percentage control appears after a non-default scale and resets both the visible transcript and persisted value; the control, composer, sidebar, and input chrome remain unscaled.

All logic sits in `chat-zoom.ts` — pure `clampZoom`/`stepZoom`/`loadChatZoom`/`saveChatZoom` plus `attachChatZoom`, which owns the listeners and the CSS variable — and a small wiring effect in ChatView. `chat-zoom.client.spec.ts` covers the helpers, reset operation, and wheel and touch binding behavior in jsdom; the ChatView component test covers the localized reset path, and the browser scroll scenario pins reader position through zoom and reset.

## Alternatives considered

- **Persist nothing; reset on reload.** Rejected: a reader who adjusts for a long thread would re-apply the same pinch every reload; the scale is device-local and tiny, so persisting it is free.
- **Scale every text node through an em-based variable.** Rejected: message font sizes are absolute px across several modules; rewiring them to em would churn unrelated styling and spacing. `zoom` scales the whole transcript box uniformly, which is what pinch means to a reader.
- **Disable native page zoom and rely on ctrl+wheel conversion.** Rejected: mobile Chromium does not expose touchscreen pinch through the desktop wheel path, and disabling document zoom would remove an accessibility control outside the transcript.

## Consequences

A mobile reader pinches to grow or shrink only the chat transcript, the scale persists per device, the visible percentage control restores the default, and plain single-finger scrolling is untouched. Native document zoom remains available outside the chat. Oxlint and the per-file coverage gate pass for the new module.

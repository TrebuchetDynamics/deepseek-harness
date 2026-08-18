# Agent Note: Mobile safe-area insets

Status: implemented

English | [中文](2026-08-18-mobile-safe-area-insets.zh.md)

## Problem

The shell pads the sidebar rail and the docked composer with fixed px. In a standalone/PWA context (the manifest is shipped), a notched device's status bar and home indicator overlap the rail's top control and the composer's bottom edge; the mobile pass so far had no safe-area handling anywhere in the client.

## Decision

Add `env(safe-area-inset-*)` to the content-level pads: the sidebar rail and expanded drawer get the top and bottom insets added to their existing padding (`calc(... + env(safe-area-inset-top/bottom))`), and the composer's bottom pad gains the bottom inset. Inside a browser tab the insets are 0, so the rules are no-ops there; in standalone mode the rail and composer clear the device chrome. The shell overlay layer and the drag handles are unaffected (they are not edge-padded chrome).

## Alternatives considered

**Pad the whole frame with the insets.** Rejected: the columns' fills should extend into the inset (full-bleed background), with only content padding at the edges — a frame pad would leave bands of background color short of the screen edges.

## Consequences

The rail, drawer, and docked composer clear notched-device chrome in standalone mode; nothing changes inside a browser tab. The sidebar-styles and mobile-touch-targets client specs pin the padding values, including inside the mobile rail media query.

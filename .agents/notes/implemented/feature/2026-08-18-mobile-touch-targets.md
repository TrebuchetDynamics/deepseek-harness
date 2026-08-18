# Agent Note: Mobile touch targets

Status: implemented

English | [中文](2026-08-18-mobile-touch-targets.zh.md)

## Problem

A 390px-viewport audit of the shell found every primary mobile control undersized for frequent touch use: the sidebar rail buttons were 36x36 (five controls), the composer send circle 34x34, the attach/commands trigger 28x28, and the plan/mode selects plus the hero workspace trigger 28px tall. Small targets make navigation and sending error-prone on touch devices and are the main "too crowded" factor of the mobile shell.

## Decision

CSS-only mobile rules at the same narrow breakpoint the layout uses for the sidebar auto-collapse (`max-width: 1023px`). The 56px rail width is contract-frozen, so the rail controls grow to 44px by taking the side padding from 10 to 6px (44 + 2*6 = 56). The two slot-owned rail controls (the workspace add/search pair and the settings trigger) were brought to the same 44px under the identical breakpoint. The composer send and attach/commands controls grow from 34/28 to 40px, the plan/mode selects get a 40px height floor, and the hero workspace trigger gets a 40px min-height. Desktop geometry is untouched: the rules live in the media query and the base declarations are unchanged (the sidebar-styles spec still pins the 36px desktop rail).

## Alternatives considered

**Widen the mobile rail instead.** Rejected: SIDEBAR_COLLAPSED is contract-frozen geometry asserted across the layout solver tests; growing the controls inside the existing 56px rail needs no constant or solver change.

**Pseudo-element hit-area expansion (invisible 44px targets).** Rejected: real size bumps are simpler, directly verifiable, and the extra size is the point of the improvement.

## Consequences

On narrow viewports the rail, composer send, attach, mode selects, and hero workspace trigger meet a 40-44px touch floor; desktop is unchanged. Style-contract specs (the ui-sidebar sidebar-styles test and a new ui-conversation mobile-touch-targets test) pin the media-query rules; the full client GUI suite and client typecheck pass. All five rail controls measure 44x44 on a rebuilt 390px bundle with no horizontal overflow; style-contract specs cover each owner (sidebar-styles, browser-styles, settings-root-styles, mobile-touch-targets).

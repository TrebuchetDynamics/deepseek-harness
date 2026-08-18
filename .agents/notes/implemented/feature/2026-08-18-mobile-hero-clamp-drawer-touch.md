# Agent Note: Mobile hero clamp and drawer touch targets

Status: implemented

English | [中文](2026-08-18-mobile-hero-clamp-drawer-touch.zh.md)

## Problem

A Playwright geometry audit of every mobile viewport (375, 390, 412, 344px wide) found two persistent defects the prior mobile pass did not cover. (1) The AgentPresetSeat preset chip (the mode pill) stayed 28px tall and, because the hero's workspace-trigger + preset row (`[workspace 183px][preset 164px]`) is wider than the 311px composer card, its right edge was clipped at the viewport (measured right=427 on a 375px screen) — the pill rendered cut in half. (2) The sidebar overlay drawer reuses the expanded layout, whose controls stay at the 28px desktop size; the mobile rule that grows sidebar controls to 44px targets only the `.collapsed` rail state, so the drawer's Collapse (28px) and New session (38px) controls never reached the touch floor. The provider/API-key input in the onboarding fetch flow also stayed 32px.

A folder-browser overlap signal from an earlier all-page detector proved to be a false positive: the dialog's scroll column clips above its opaque footer (column bottom 439 < footer top 455 on a 375px run), so no fix was needed.

## Decision

CSS-only mobile rules under the same narrow breakpoint the layout uses for the sidebar auto-collapse (`max-width: 1023px`):

- HeroShell: nothing here; the row lives in ConversationRoot — `.heroWorkspaceRow` wraps (`flex-wrap: wrap; row-gap: 8px`) so the preset chip drops to its own line instead of clipping past the composer card's right edge.
- AgentPresetSeat: `.seat` gets `min-height: 40px`, matching the workspace trigger it shares the row with (the 40px touch floor the rest of the hero uses).
- SidebarRoot: the drawer (non-`.collapsed`) `.iconButton` grows to 40x40 and `.newSession` to `min-height: 40px`; the rail's 44px rule is untouched.
- ModelsSection: the provider/API-key `.input` gets `min-height: 40px`.

Desktop geometry is unchanged: all rules live in the media query and the base declarations are untouched.

## Alternatives considered

**Shrink the preset chip to fit (flex: 1 + ellipsis).** Rejected: truncating the preset name hurts discoverability on the new-session screen; wrapping to a second line keeps the full label at every narrow width.

**Raise the drawer controls to 44 to match the rail.** Rejected: the rail's 44px came from taking its fixed side padding inside the 56px rail (44 + 2*6 = 56); the free-form drawer has no such constraint and matches the 40px floor used across the composer and hero.

**Grow the drawer's session toolbar (Search / View options / Add workspace) too.** Rejected in testing: the 28px toolbar sits inside contract-frozen compact containers (`.searchSlot` max-width 28px, `.headerActions` max-width 60px, `.sectionHeader` height 36px); growing the circles to 40px pushed the search button 8px into "View options" and clipped "Add workspace", so those secondary utility icons keep the S1 baseline.

## Consequences

On narrow viewports the preset chip is never clipped and both hero chips are 40px tall; the drawer's primary controls (Collapse, New session) meet the 40px floor and the provider input grows to 40px; desktop is unchanged. Style-contract specs pin each rule (a new ui-agent-preset seat-style spec; extended ui-sidebar sidebar-styles, ui-conversation mobile-touch-targets, and ui-settings-models styles specs). A rebuild plus Playwright re-measure confirmed the preset chip at 40px with its right edge inside the 375px viewport, the drawer primaries at 40px, and zero clipped or overlapping controls across all four mobile viewports.

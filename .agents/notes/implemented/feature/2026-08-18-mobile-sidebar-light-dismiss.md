# Agent Note: Mobile sidebar light dismiss

Status: implemented

English | [中文](2026-08-18-mobile-sidebar-light-dismiss.zh.md)

Superseded in part by [Mobile overlay drawer](2026-08-18-mobile-overlay-drawer.md): the backdrop now dims the full frame behind the overlaying drawer; the dismiss mechanism described here is unchanged.

## Problem

On narrow viewports (below the SIDEBAR_AUTO_COLLAPSE breakpoint) the sidebar auto-collapses to the rail, and the rail toggle re-expands it as a wide drawer over the squeezed center. There was no way back except the rail toggle at the column's far edge or crossing the breakpoint: after selecting a session the drawer stayed covering most of the screen with no tap-to-dismiss. The standard mobile drawer contract, tap outside the panel (or press Escape) to collapse it, was missing.

## Decision

AppFrame owns the light-dismiss surface for the narrow expanded state. When the viewport is narrow and the sidebar is expanded, it renders a transparent backdrop (`.scrim`) covering the area right of the sidebar column (absolutely positioned at `left: cols.sidebar`, below the shell overlay layer's z-index 20) and installs a window `keydown` listener for Escape; both collapse through the layout store's new `closeSidebar` action. `closeSidebar` mirrors `closeDetails`: on narrow it clears the `narrowExpanded` re-expand override so the width preference survives re-widening, and on wide it writes `sidebar = 0`. The wide desktop layout is untouched, no scrim, no keybinding.

## Alternatives considered

**Reuse `toggleSidebar` for the dismiss.** Rejected because the backdrop only ever renders while the drawer is expanded, yet a dedicated action keeps the operation explicit, is a no-op when already closed, and completes the existing `closeDetails`/open pair.

**Dim the backdrop like a modal drawer.** Rejected because the expanded sidebar squeezes, not overlays, the center, so dimming would hide content without adding affordance; the request was behavioral (tap outside collapses), so the backdrop stays transparent.

## Consequences

On mobile an expanded sidebar dismisses by tapping the area to its right or pressing Escape, leaving the width preference intact for re-widening. Escape is scoped to the narrow expanded state, so desktop keyboard behavior is unchanged. The app-frame and layout-store client specs cover the backdrop tap, Escape, the absence of a backdrop on wide viewports, and the no-op-when-closed action.

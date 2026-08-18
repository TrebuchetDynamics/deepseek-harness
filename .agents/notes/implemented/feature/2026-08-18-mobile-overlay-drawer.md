# Agent Note: Mobile overlay drawer

Status: implemented

English | [中文](2026-08-18-mobile-overlay-drawer.zh.md)

Supersedes the transparent-scrim rationale of [Mobile sidebar light dismiss](2026-08-18-mobile-sidebar-light-dismiss.md); the tap-outside/Escape mechanism there is unchanged.

## Problem

On narrow viewports the expanded sidebar squeezed the center column to a ~110px sliver at 390px wide instead of overlaying it: the conversation reflowed into a useless sliver beside the drawer, and the light-dismiss backdrop was transparent, so the drawer did not read as modal. A mobile drawer should overlay its surface under a dimmed backdrop (the standard navigation-drawer pattern).

## Decision

AppFrame keeps the sidebar as a normal grid item, so the collapse slide still rides the existing grid-track transition and SidebarRoot's frozen-width phases are untouched. When narrow and expanded (`data-drawer` on the frame), the center column spans every track (`grid-column: 1 / -1`), so the conversation keeps its full width behind the drawer, and the sidebar column lifts above it (`z-index: 12`). The light-dismiss surface becomes a full-frame backdrop that mounts whenever narrow and fades with the slide (`--dsw-alias-bg-mask-2`, lighter than the modal's mask-1), visible and pointer-active only while the drawer is open; tapping it or pressing Escape collapses through the existing `closeSidebar` action. The narrow drawer is fixed at the contract default, so its resize handle no longer renders on touch layouts.

## Alternatives considered

**Keep the squeeze and dim only the sliver.** Rejected: a 110px strip of dimmed content reads as broken, not modal; the conversation must stay at full scale behind the drawer.

**Absolute-position the sidebar out of the grid.** Rejected: it would bypass the grid-track slide and force a parallel width animation, breaking the frozen-width fade phases in SidebarRoot; keeping the sidebar in flow preserves the whole collapse machinery.

## Consequences

On narrow viewports the expanded sidebar is a true overlay drawer: full-width dimmed conversation behind, tap-outside or Escape to dismiss, no resize handle. Desktop is unchanged (no backdrop, handle as before). App-frame and app-frame-styles client specs cover the overlay state, the always-mounted fading backdrop, and the removed narrow handle.

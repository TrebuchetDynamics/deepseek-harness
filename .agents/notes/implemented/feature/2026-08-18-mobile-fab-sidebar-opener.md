# Agent Note: Mobile FAB sidebar opener

Status: implemented

English | [中文](2026-08-18-mobile-fab-sidebar-opener.zh.md)

Supersedes in part [Mobile overlay drawer](2026-08-18-mobile-overlay-drawer.md): on narrow the closed state is now fully hidden (no rail) behind a floating opener; the drawer + dimmed-backdrop overlay behavior it documents is unchanged.

## Problem

On narrow viewports the auto-collapsed sidebar stayed as a 56px control rail (SIDEBAR_COLLAPSED), permanently consuming a column of width on phones where every pixel matters, and there was no always-visible way to expand it without reaching the rail's far-edge toggle. The mobile sidebar should take no width when closed — like ChatGPT, only a floating button should draw it in.

## Decision

computeColumns takes a narrow flag: a closed sidebar resolves to 0 (instead of the 56px rail) when narrow, while the desktop closed state keeps the rail. On narrow, AppFrame renders a floating circular opener button (.fab, safe-area-inset positioned top-left) whenever the sidebar is closed; it expands through the layout store's new openSidebar action (narrow-only: sets narrowExpanded; a no-op wide) and is hidden while the drawer is open so the dimmed backdrop reads clean underneath. The hidden narrow sidebar is inert and `aria-hidden`; opening moves focus into the drawer, makes the center and details columns inert, and contains Tab navigation inside the sidebar, while backdrop, Escape, and sidebar-action dismissal restore focus to the opener. The desktop rail and drag handle are unchanged.

## Alternatives considered

**Force a zero-width rail purely via CSS on narrow.** Rejected: the rail width is decided inside the concession solver, and a CSS override would desync the slot width owner-prop and the center track from the resolved geometry. The explicit narrow solver parameter keeps geometry single-sourced.

**Reuse toggleSidebar from the opener.** Rejected: the opener must expand an already-closed drawer without flipping an open one shut; a dedicated openSidebar action (the mirror of closeSidebar) is idempotent and wide-safe.

**Render the opener always and let the backdrop cover it.** Rejected: unmounting it while the drawer opens is simpler and leaves no hidden-but-focusable control under the drawer.

## Consequences

On phones the sidebar occupies zero width when closed; a top-left floating button draws it in as a drawer and hides while it is open. Desktop keeps its 56px rail and drag handle. The columns solver, layout-store, app-frame client specs, and mobile browser scenario cover zero-width collapse, background inertness, contained focus, opener lifecycle, drawer geometry, and `openSidebar`'s wide no-op; the ui-layout README documents the narrow hidden + opener behavior.

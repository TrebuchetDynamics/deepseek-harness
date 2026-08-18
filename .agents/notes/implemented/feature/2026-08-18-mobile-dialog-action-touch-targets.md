# Agent Note: Mobile dialog action touch targets

Status: implemented

English | [中文](2026-08-18-mobile-dialog-action-touch-targets.zh.md)

## Problem

The first-run onboarding modal (welcome notice and credential dialog) rendered its actions — Continue, Configure later, Save and continue — at 36px tall, below the 44px target chosen for primary mobile actions, alongside the same sub-44px rail and composer controls fixed by the earlier mobile touch-target pass. Dialog actions are the most frequent first-tap targets on a fresh install.

## Decision

ui-primitives' shared Button owns the fix: the standard action form (`.md`, 36px) grows to 44px under the same narrow breakpoint the layout uses for the sidebar auto-collapse (`max-width: 1023px`). The compact `.sm` form is left untouched for dense rows. A single media-scoped rule covers every dialog action — onboarding, credential, and future dialogs — at their shared owner instead of per-modal overrides.

## Alternatives considered

**Scope the bump to the onboarding modal only.** Rejected: the floor applies to every dialog action on touch devices, and per-modal overrides would duplicate the rule and drift.

## Consequences

All standard dialog/action buttons reach 44px on narrow viewports; desktop keeps the 36px form (media-scoped). The button-styles client spec pins the rule and the unchanged desktop height.

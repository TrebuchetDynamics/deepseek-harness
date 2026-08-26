# Agent Note: Ask-question Web presentation

Status: implemented

English | [中文](2026-07-29-ask-question-web-presentation.zh.md)

## Problem

The Web GUI could already collect answers through the `QuestionComposer` composer takeover, but the transcript around it was wrong on three counts. A pending question rendered twice: once as the composer takeover and once as the read-only `PendingCard` placeholder that predates the takeover. A settled `ask_user_question` call rendered as the generic "Tool call" row dumping raw args JSON, so the two composer verdicts — the user dismissing the whole set (`ASK_CANCELLED`) and a turn interrupt landing while the question was pending (`ASK_ABORTED`) — both read as anonymous red-dot failures. And the composer's own chrome copy (pager, buttons, placeholders, validation feedback) was hardcoded Chinese while the surrounding client is bilingual through `dsh-client-locale`.

Separately, the composer visuals had drifted from the current design: an expand-to-open custom answer entry, no multi-select affordance beyond a trailing check, header-mounted paging, and a `（可多选）` title-suffix convention parsed out of model text.

## Decision

A pending question owns exactly two surfaces: the composer takeover collects the answers, and a dedicated `ask_user_question` toolview row in the transcript names the interaction outcome. The row registers into the keyed `tool.call.toolview` hole exactly like `todo_write` and composes the shared `ToolRow` (chrome, running sweep, leading expansion). Its summary is the interaction verdict rather than args: `waiting` while running, `N/M answered` from the result JSON once settled (a skipped answer — empty `selected`, no `custom` — stays out of the count), `cancelled` for `ASK_CANCELLED`, and `interrupted` with the shared amber stopped semantics for `ASK_ABORTED`. Malformed or truncated results fall back to the generic summary. `PendingCard` narrowed to `PendingWait<'approval'>` and `ChatView` filtered the pending list to approval waits, leaving the placeholder card to approvals alone; the approval composer takeover ([web permission and approval](2026-07-23-web-permission-and-approval.md)) has since removed it entirely.

An accepted ordinary `session.prompt` means the user chose to speak instead of answering the structured question. The Host admits that message to the Agent inbox before claiming every pending question for the same Session as `ASK_CANCELLED`; failed prompt admission leaves the questions answerable, and the first structured response or superseding prompt to claim a question wins. The tool schema reserves this blocking wait for human-owned choices and missing information; it tells the model to use a safe, reversible default instead of asking for optional confirmation or a status update.

The composer redesign moves paging into the footer next to the actions, renders multi-select options with explicit checkboxes, keeps single-select numbered rows, and replaces the expand-to-open custom entry with an always-visible custom input row (textarea for optionless questions). Selecting a single-choice option advances to the next question or submits the complete structured answer immediately when it is the final question; the choice never needs a second gesture that could become an ordinary prompt. The `parseQuestionTitle` multi-select suffix convention is deleted; `multi_select` is already structured metadata, so the title renders verbatim.

Composer chrome copy becomes bilingual: the plugin registers zh/en dictionaries under the `question` namespace of `dsh-client-locale` and hands the entry a namespace-bound translator plus the locale snapshot as a hooks-compartment source through the slot inject face, so a locale flip re-renders a mounted composer. Validation feedback is stored as a dictionary key and re-translated on flip; carrier failure messages and all model-authored question/option text render verbatim.

Two adjacent fixes ride along. All generic toolview leading icons (and the hover chevron) now inherit the single tertiary label color — the others-variant secondary override and the separate chevron color rule are deleted, leaving only the intentional cordis business-primary accent. And the client dev-watch bundler registers each CSS module with `addWatchFile`, because the virtual-module indirection previously hid css-only edits from the watcher.

## Alternatives considered

**Keep rendering questions through `PendingCard`.** Rejected: the card was a read-only placeholder from before the takeover existed, so a pending question showed the same content twice with one copy not answerable. The toolview row plus takeover covers both the transcript record and the collection surface.

**Leave ordinary prompts queued behind a pending question.** Rejected: a client without the question composer can accept the message but cannot settle the blocking tool call, so neither the queued message nor the turn can advance.

**Show the questions or answers inline in the transcript row.** Rejected: the composer takeover owns question rendering and answer collection, and the row convention (`todo_write`) is one line with details in the panel. The row therefore reports only the outcome, mirroring how the todo row reports counts while the panel owns the list.

**Render `ASK_CANCELLED`/`ASK_ABORTED` through the generic error shape.** Rejected: dismissal is the user's own deliberate action and an interrupt is the shared stop gesture; both are expected outcomes, not tool failures. Naming the verdict (and keeping amber stopped semantics for the abort) matches how interrupted tool calls read elsewhere.

**Translate the row verdicts now.** Deferred by explicit product decision: the row's `waiting`/`answered`/`cancelled`/`interrupted` strings stay English for this change; the composer chrome i18n landed because its Chinese-only copy was already wrong for the en locale.

**Keep the title-suffix multi-select convention.** Rejected: `multi_select` is structured request metadata and the checkbox affordance now carries the signal, so parsing `（可多选）` out of model text was a fragile duplicate channel.

## Consequences

`ask_user_question` and `todo_write` now demonstrate the intended toolview pattern: compose `ToolRow`, summarize from call args or result JSON with shape-checked fallbacks, and register through the keyed slot. The bespoke `todo-row.module.css` is gone.

Clients that cannot render the structured composer can escape a question wait by sending an ordinary prompt. That prompt produces a cancelled tool result before the queued message reaches the next model step, so the model receives both the abandoned interaction and the user's replacement text.

The row verdict strings are the one remaining hardcoded-English surface of the question flow; localizing them is deferred follow-up. The approval composer takeover shipped ([web permission and approval](2026-07-23-web-permission-and-approval.md), height-capped per the [approval-panel note](../bug-fix/2026-07-30-approval-panel-command-cap.md)), and `PendingCard` no longer exists.

`ui-user-questions` gains a `dsh-client-locale` dependency and an inject face where it previously had none; its contract (`QuestionComposerInjected`) lives with the consumer in `contract/slots.ts`.

## Verification

`ui-conversation` tests pin the row's waiting/answered/skipped/cancelled/interrupted/fallback matrix, the approval-only pending filter, and the slot registration; `ui-user-questions` tests pin the redesigned composer (checkbox multi-select, immediate final single-choice submission, always-visible custom row, footer pager, dictionary-key feedback re-translation, IME-safe Enter) and the plugin's dictionary registration plus inject face; `ui-primitives` tests pin the icon set. `dsh-host-apiproxy` pins ordinary-prompt supersession through the same public question and prompt methods. The assembled Web GUI exercises single-gesture structured answers, cancellation, and turn interruption.

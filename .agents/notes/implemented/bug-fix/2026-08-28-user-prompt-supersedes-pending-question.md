# Agent Note: User prompt supersedes a pending question

Status: implemented

English | [中文](2026-08-28-user-prompt-supersedes-pending-question.zh.md)

## Problem

A user can send a new prompt while `ask_user_question` is waiting. Treating that prompt as unrelated leaves the tool call blocked, but cancelling on attempted or unrelated input can discard a question even though no replacement prompt reached its agent. Cancellation alone is also insufficient when an answerer observes its signal late and returns an answer after supersession.

## Decision

`UserQuestionService` indexes pending agent-scoped asks by the exact live `Agent` object. An `agent/inbox/inserted` event whose message source is `user` aborts every pending ask for that exact agent with `ASK_CANCELLED`. The insertion event is the admission point: Host-rejected prompts emit no insertion, non-user messages do not express a replacement user decision, and another agent has independent pending state.

The service combines the caller signal with an internal supersession signal for answerers. It also rechecks supersession after the waterfall settles, so an answerer that ignores or observes cancellation late cannot make its answer win. Every ask removes its controller in `finally`, and disposal removes the inbox listener through the owning Cordis fiber.

## Alternatives considered

**Cancel on every prompt attempt.** Rejected because transport or admission policy may reject the prompt before it enters the Agent inbox; no new work then exists to replace the pending question.

**Rely only on answerers to reject when their signal aborts.** Rejected because an answerer may settle concurrently or fail to cooperate with cancellation. The service owns which outcome wins and therefore rechecks before returning.

**Cancel pending asks across all agents.** Rejected because Agent scope is the interaction owner; a prompt for one live root must not affect another root's question.

## Consequences

A new admitted user prompt deterministically wins over pending questions for its agent, including late-answer races. Programmatic agentless asks have no Agent inbox owner and retain their existing caller-signal behavior. Focused service tests pin exact-agent cancellation, excluded inputs, late settlement, cleanup, and listener disposal; the Web component test pins immediate submission for a sole single-choice question.

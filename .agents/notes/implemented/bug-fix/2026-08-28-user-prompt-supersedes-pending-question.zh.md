# Agent Note: 用户提示取代待处理问题

Status: implemented

[English](2026-08-28-user-prompt-supersedes-pending-question.md) | 中文

## Problem

用户可以在 `ask_user_question` 等待期间发送新提示。若把该提示视为无关输入，工具调用会继续阻塞；但若针对尝试发送或无关输入取消问题，即使没有替代提示到达对应 agent，也可能丢弃问题。仅发出取消信号同样不够，因为 answerer 可能较晚才观察信号，并在取代发生后返回回答。

## Decision

`UserQuestionService` 按存活 `Agent` 的精确对象索引带 agent scope 的待处理 ask。消息来源为 `user` 的 `agent/inbox/inserted` 事件会以 `ASK_CANCELLED` 中止该精确 agent 的所有待处理 ask。插入事件就是接纳点：Host 拒绝的提示不会产生插入，非用户消息不表示替代用户决定，其他 agent 则拥有独立的待处理状态。

服务为 answerer 合并调用方信号与内部取代信号。waterfall 完成后，服务还会再次检查是否已被取代，因此忽略取消或较晚才观察取消的 answerer 无法让其回答胜出。每个 ask 都在 `finally` 中移除自己的控制器；Cordis fiber 释放时会移除 inbox listener。

## Alternatives considered

**在每次提示尝试时取消。** 拒绝该方案，因为传输层或接纳策略可能在提示进入 Agent inbox 前拒绝它；此时并没有新工作取代待处理问题。

**仅依赖 answerer 在信号中止时拒绝。** 拒绝该方案，因为 answerer 可能并发完成，也可能不配合取消。服务拥有最终结果的选择权，因此必须在返回前重新检查。

**取消所有 agent 的待处理 ask。** 拒绝该方案，因为 Agent scope 才是交互所有者；发给一个存活根的提示不得影响另一个根的问题。

## Consequences

新的已接纳用户提示会确定性地胜过该 agent 的待处理问题，包括较晚回答的竞态。无 Agent inbox 所有者的程序化 agentless ask 保留现有的调用方信号行为。聚焦服务测试固定精确 agent 取消、排除输入、较晚完成、清理与 listener 释放；Web 组件测试固定单个单选问题的即时提交行为。

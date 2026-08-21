# Agent Note: 每次消息的确定性会话标题

Status: implemented

[English](2026-08-18-session-title-latest-message-plugin.md) | 中文

## 问题

已发布的默认标题策略（`@deepseek-ai/dsh-session-title-first-prompt-llm`）只在第一个提示词之后通过一次辅助 LLM 调用标题会话。产品希望会话在每个用户消息后都确定性重命名，不发起任何辅助请求，使会话名始终反映最新的消息。

## 决定

新插件 `@deepseek-ai/dsh-session-title-latest-message` 以 `all-prompts` 节奏注册唯一的 `ctx.sessionTitle` 提供方。`generate()` 返回最新符合条件人类消息的前导词，使用与内置回退相同的清洗、词数和 UTF-8 安全截断，并将标题归属于该消息的确切 seq。由于标题服务只接受一个提供方，基础 bundle 的默认标题行从首个提示 LLM 提供方切换为本插件；偏好 LLM 标题的部署将行的提供方改回（或直接挂载 `dsh-session-title-all-prompts-llm`）。

自动工作仍只在消息对应的主请求头被记录后启动，因此重命名恰好落在代理处理该消息之时；更新的修订会在服务内部中止并取代旧工作。重命名只产生仅日志的 `session/title` 事件。

## 备选方案

**改为挂载 `@deepseek-ai/dsh-session-title-all-prompts-llm`。** 已拒绝：它要求每条消息一次辅助 LLM 请求并生成摘要式标题；而需求是确定性的最新消息重命名。

**监听 `user/message` 并调用 `sessionTitle.rename()`。** 已拒绝：`rename()` 记录 `user` 来源的标题、`messageSeqs` 为空并把会话钉住以对抗自动工作，即歪曲了派生方式并绕过了服务的取代、取消与节奏机制。

## 后果

每个会话——包括子会话——都会在该消息的请求启动时重命名为其最新符合条件人类消息的前导词。没有辅助 LLM 请求：主请求的 token 与 KV 缓存效果不受影响。首个提示与全部提示的 LLM 提供方仍保留在仓库中，供偏好模型生成标题的部署使用。
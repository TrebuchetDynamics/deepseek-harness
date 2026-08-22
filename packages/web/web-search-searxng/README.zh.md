# @deepseek-ai/dsh-web-search-searxng

[English](README.md) | 中文

由 [SearXNG](https://docs.searxng.org) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它调用 SearXNG/SearX 实例的 JSON 搜索端点（`GET /search?q=…&format=json`），并把聚合器的扁平 `results[]` 映射为 seam 规范化的 `WebSearchResult`。

**SearXNG 是自托管、无密钥的元搜索聚合器** —— 它从自己的主机/IP 查询上游引擎（Google、Bing、DuckDuckGo、Mojeek、Brave 等），返回合并后的 JSON 结果。这正是它成为**完全免费**网页搜索途径的原因：在此 harness 中，三个内置提供方（`deepseek-official`、`exa`、`perplexity`）都是付费或需密钥。SearXNG 无需 API 密钥、无需账户，且反机器人 IP 信用问题作用于 SearXNG 所在主机，而非你的 harness 进程。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `$SEARXNG_BASE_URL`（否则为不可达占位符） | SearXNG 实例基址；追加 `/search?format=json`。**必须指向你控制或信任的托管实例。** 无法解析的值使提供方不可用。 |
| `engines` | （未设） | 可选逗号分隔引擎集，作为 SearXNG 的 `engines` 传递。留空则不传（用实例默认）。 |
| `language` | （未设） | 可选语言／区域（如 `en-US`），作为 SearXNG 的 `language`。 |

```yaml
- id: web-search-searxng
  name: '@deepseek-ai/dsh-web-search-searxng'
  config:
    baseURL: !!js process.env.SEARXNG_BASE_URL
```

## 映射

SearXNG 返回扁平 `results[]` 且无生成答案，因此省略 `content`（面向模型的工具渲染可选答案＋来源列表）。每个结果映射为 `WebSearchSource`：`url` ← `url`，`title` ← `title`，`snippet` ← `content`，`publishedAt` ← `publishedDate`。无可用 `url` 的结果被丢弃；空 `title`／`content`／日期省略而非杜撰。最终来源数量上限由 web seam 强制。提供方失败以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求为 `WEB_ABORTED`；HTTP 重定向在联系 `Location` 目标前被拒绝。

## 模型体验

间接经 [tool-web](../tool-web/README.zh.md)：保留本提供方 `maxResults` 限制的 URL、标题、摘要与发布日期，或保留其精确错误（`SearXNG search aborted`、`SearXNG search request failed: <error>`、`SearXNG search error (HTTP <status>)`、`SearXNG returned an unprocessable response body: <error>`），由消费方包装。

## 已知限制与待办

- **SearXNG 输出随实例配置不同** —— JSON 结果形态标准，但填充字段集与上游引擎取决于部署的 `SEARXNG_ENGINES`。当上游只返回标题时，`title`／`content` 可能稀疏。
- **公共 SearXNG 实例常限制 JSON 查询**（观察到 403/429）。**请自行托管**（compose/docker 几分钟即可）。
- **无缓存、无逐引擎调校**——SearXNG 的 `format`、`categories`、`time_range` 控制待 provider-neutral Service Definition 字段。
- **通用反机器人信用无法消除**——聚合器仍依赖上游引擎容忍其查询。

## 不适用于

- **私有／敏感流量** —— SearXNG 会把你查询转发给第三方搜索引擎；不要用它搜索内容可能到达上游引擎主机的查询。这是公共网页搜索提供方。
- **替代付费提供方** —— 在需要服务端检索并附带 AI 答案的部署中，SearXNG 返回结构化链接而非生成答案。

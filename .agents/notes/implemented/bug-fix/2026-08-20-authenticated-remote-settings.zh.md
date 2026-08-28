# Agent Note: 经认证的反向代理可以向其属主开放设置

Status: implemented

[English](2026-08-20-authenticated-remote-settings.md) | 中文

## 问题

浏览器设置层把所有非 loopback URL 判定为永久不可用，并且从不调用 `settings.describe`。这在展示代码中重复了 Host 的授权判断：经认证的反向代理可以向 Host 提供获准的 loopback authority，但 Models 页面仍以 `settings are unavailable in this browser` 失败。仅限属主的插件路由也有相同的集成要求：Task Board 会拒绝普通 trusted Host，并要求列入 allowlist 的代理 authority 与私有令牌。Remote SSH 独立要求回环 socket、Host 与浏览器 Origin 标记，因此代理不转换 authority 时，即使已认证属主也会被其 API 与终端拒绝。

## 决策

浏览器设置始终使用 Host transport。Connection 使用进程启动令牌交换所得、绑定 authority 的浏览器 cookie 来认证完整 Host API。Tailscale Caddy matcher 为配置 namespace 与已集成的仅限属主插件路由保留浏览器 `Host` 和 `Origin`，只为 `TAILSCALE_OWNER` 转发这些路径，并在 fallback 代理之前对其他身份返回 403。trusted host 仍用于 DNS rebinding 与跨站检查，而不代表用户身份。

Task Board 保留自身的代理防护，而不接收 loopback 改写。启动器生成新的随机令牌，仅与 Host 和 Caddy 容器共享；Caddy 只在匹配 `TAILSCALE_OWNER` 后注入该令牌，fallback 代理会移除客户端提供的同名令牌。Caddy 保留浏览器 authority 与请求标记；尤其不会为同源 GET 请求合成空的 `Origin`，这类请求以 `Sec-Fetch-Site: same-origin` 作为浏览器证明。

显式的内存模式仍供嵌入式消费者和测试使用，但生产环境不再根据 URL 分类选择它。

## 备选方案

**保留客户端远程阻断并增加代理 capability 标志。** 否决：该标志会增加第二个授权信号和一套协议，仅用于决定浏览器是否可以尝试 RPC。它无法授予访问权限，因为 Host 仍必须授权每个请求。

**向每个 trusted host 开放属主控制。** 否决：trusted host 防止 DNS rebinding 和跨站请求，并不认证用户。代理先认证 Tailscale 身份，再改写仅限 loopback 的 authority 或注入路由专用令牌。

**把 Task Board 请求改写为 loopback。** 否决：这会绕过插件明确的代理 Host 与令牌检查。保留公开 authority 可同时维持 Caddy 属主检查和插件自身的独立防护。

## 后果

经过一次浏览器启动令牌交换后，已认证的 Tailscale 属主可以加载 Models、持久设置页面和明确集成的属主控制。其他 tailnet 身份即使持有有效 Harness 浏览器会话，在敏感路径前缀上仍会收到 403。聚焦测试固定当前路径前缀、浏览器 authority 保留、启动令牌交换，以及属主 200 与非属主 403 探测。

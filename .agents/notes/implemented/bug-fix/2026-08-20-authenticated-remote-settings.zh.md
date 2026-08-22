# Agent Note: 经认证的反向代理可以向其属主开放设置

Status: implemented

[English](2026-08-20-authenticated-remote-settings.md) | 中文

## 问题

浏览器设置层把所有非 loopback URL 判定为永久不可用，并且从不调用 `settings.describe`。这在展示代码中重复了 Host 的授权判断：经认证的反向代理可以向 Host 提供获准的 loopback authority，但 Models 页面仍以 `settings are unavailable in this browser` 失败。仅限属主的插件路由也有相同的集成要求：Task Board 会拒绝普通 trusted Host，并要求列入 allowlist 的代理 authority 与私有令牌。

## 决策

浏览器设置始终使用 Host transport。Host 仍是授权权威：普通远程请求由 Host 拒绝，而经认证的反向代理只能为已识别的属主改写 `Host` 与 `Origin`。Tailscale Caddy matcher 包含远程 GUI 使用的配置方法与仅限属主的插件路由。

Task Board 保留自身的代理防护，而不接收 loopback 改写。启动器生成新的随机令牌，仅与 Host 和 Caddy 容器共享；Caddy 只在匹配 `TAILSCALE_OWNER` 后注入该令牌，fallback 代理会移除客户端提供的同名令牌。Caddy 保留浏览器 authority 与请求标记；尤其不会为同源 GET 请求合成空的 `Origin`，这类请求以 `Sec-Fetch-Site: same-origin` 作为浏览器证明。

显式的内存模式仍供嵌入式消费者和测试使用，但生产环境不再根据 URL 分类选择它。

## 备选方案

**保留客户端远程阻断并增加代理 capability 标志。** 否决：该标志会增加第二个授权信号和一套协议，仅用于决定浏览器是否可以尝试 RPC。它无法授予访问权限，因为 Host 仍必须授权每个请求。

**向每个 trusted host 开放属主控制。** 否决：trusted host 防止 DNS rebinding 和跨站请求，并不认证用户。代理先认证 Tailscale 身份，再改写仅限 loopback 的 authority 或注入路由专用令牌。

**把 Task Board 请求改写为 loopback。** 否决：这会绕过插件明确的代理 Host 与令牌检查。保留公开 authority 可同时维持 Caddy 属主检查和插件自身的独立防护。

## 后果

经过认证的 Tailscale 属主可以加载 Models、持久设置页面和明确集成的属主控制。其他 tailnet 身份仍由 Host 拒绝，因为 Caddy 不会为其改写 authority 或提供私有路由凭据。聚焦客户端测试覆盖远程 mirror 和 scope 激活；经 Tailscale Serve 的真实 Playwright 检查覆盖设置读取，以及 Task Board 的状态、事件、创建、筛选、移动与删除操作。

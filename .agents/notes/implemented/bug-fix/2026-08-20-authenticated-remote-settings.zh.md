# Agent Note: 经认证的反向代理可以向其属主开放设置

Status: implemented

[English](2026-08-20-authenticated-remote-settings.md) | 中文

## 问题

浏览器设置层把所有非 loopback URL 判定为永久不可用，并且从不调用 `settings.describe`。这在展示代码中重复了 Host 的授权判断：经认证的反向代理可以向 Host 提供获准的 loopback authority，但 Models 页面仍以 `settings are unavailable in this browser` 失败。Docker Tailscale 代理已经授权仅限属主的设置和凭据方法，但 provider directory 请求也遗漏在仅限属主的 matcher 之外。

## 决策

浏览器设置始终使用 Host transport。Host 仍是授权权威：普通远程请求由 Host 拒绝，而经认证的反向代理只能为已识别的属主改写 `Host` 与 `Origin`。Tailscale Caddy matcher 同时包含 `settings.*` 与 `llm.providers`，因此 Models 页面通过同一属主检查加载共享设置文档和 provider directory。

显式的内存模式仍供嵌入式消费者和测试使用，但生产环境不再根据 URL 分类选择它。

## 备选方案

**保留客户端远程阻断并增加代理 capability 标志。** 否决：该标志会增加第二个授权信号和一套协议，仅用于决定浏览器是否可以尝试 RPC。它无法授予访问权限，因为 Host 仍必须授权每个请求。

**向每个 trusted host 开放设置。** 否决：trusted host 防止 DNS rebinding 和跨站请求，并不认证用户。代理必须先认证 Tailscale 身份，再改写 authority。

## 后果

经过认证的 Tailscale 属主可以加载 Models 和其他持久设置页面。未经认证的远程浏览器会发起由 Host 拒绝的设置读取，而不是在请求之前被禁用。聚焦客户端测试覆盖远程 mirror 和 scope 激活；经 Tailscale Serve 的真实 headless Chromium 运行观察到成功的 `settings.describe` 与 `llm.providers` 响应，并渲染了 Models provider 卡片。

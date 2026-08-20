# Agent Note: 持久化宿主机 Web 服务

Status: implemented

[English](2026-08-20-host-web-systemd-service.md) | 中文

## Problem

前台 Web 启动器会随其 shell 停止，也不会在重启或进程故障后恢复。容器启动器提供持久性，但会把 agent 与宿主机工具链、设备、凭据及工作区隔离，而宿主机原生部署需要有意使用这些资源。以 root 身份运行具备 agent 能力的进程，会把安装权限转化为永久的运行时权限。

## Decision

`run-web.sh` 在 Fedora 和 Ubuntu 上安装并管理 systemd 系统服务。安装器仅在写入 unit、root 所有的配置、管理 `tailscaled` 及一次性授予 Tailscale operator 角色时使用 `sudo`；服务则以发起安装的非 root 账户运行源码检出，并显式设置 `HOME`、`DSH_HOME`、工作目录、Node、pnpm 与 `PATH`。除非明确指定非 root 服务账户，否则拒绝直接以 root 安装。

若 pnpm 不存在，安装器会通过 Corepack 启用仓库固定的 pnpm，然后以服务账户运行 `pnpm install --frozen-lockfile` 与 `pnpm run build`。启动过程不会安装依赖或编译产物。系统 unit 在 `tailscaled` 之后启动，故障后自动重启，并且只会在它拥有的 Web 子进程通过 DSH API 探测、两条 Tailscale Serve 路由均可访问后报告就绪。

服务拥有所配置的 Serve 端口。首次安装 unit 前若发现已有路由，启动会拒绝替换；关闭时会先移除两条路由，再等待子进程退出。安装也拒绝替换另一个 Tailscale operator。`/etc/dsh-web.env` 保存 Fedora 与 Ubuntu 共用的可移植标量配置；生命周期命令提供安装、启动、停止、重启、状态、日志、前台运行与卸载操作。

Tailscale 策略仍是访问控制权威。trusted-host 参数允许预期的 Host 与 Origin 值，但不会认证 tailnet 用户。

## Alternatives considered

**保留前台启动器。** 连接 shell 的进程适合诊断，但无法满足开机持久化、受监督重启或确定性路由清理。

**只使用容器启动器。** 容器提供可复现部署，但若不添加大量挂载和设备映射，就无法暴露完整宿主机环境；这些配置又会削弱隔离效果。两种部署模式继续并存，因为它们针对不同的信任与可移植性要求。

**安装以 root 运行的系统服务。** 这会简化 unit 与 Tailscale 的访问，却也会向每个 agent 工具及子进程授予 root 权限。因此，特权仅限于安装阶段。

**安装启用 linger 的用户 unit。** 用户 unit 需要发行版及账户相关的 linger 设置，仍需要特权配置 Tailscale operator。带 `User=` 的系统 unit 在保留非特权运行身份的同时提供统一的启动生命周期。

## Consequences

准备完成的源码检出可在退出登录、重启和进程故障后继续运行，同时保留直接宿主机访问。移动或删除源码检出会使启动失败，直到从新路径重新安装服务。选定的非 root 账户会成为 Tailscale operator；已有的其他 operator 或 Serve 路由必须显式处理。停止服务会有意移除其配置的暴露，因此这些 Serve 端口不能与无关应用共享。

聚焦启动器测试覆盖生命周期帮助、unit 渲染、路径转义、特权 unit 安装前的换行拒绝，并在 `systemd-analyze` 可用时验证 systemd 配置。真实 Fedora 与 Ubuntu 宿主机仍是安装、重启、Tailscale 证书和网络可达性行为的最终验证环境。

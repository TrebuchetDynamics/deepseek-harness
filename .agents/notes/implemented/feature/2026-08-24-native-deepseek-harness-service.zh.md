# Agent Note: DeepSeek Harness 原生服务

Status: implemented

[English](2026-08-24-native-deepseek-harness-service.md) | 中文

## Problem

容器只能访问明确暴露给它的宿主路径、socket、设备与环境。即使 Harness 组合提供了大量挂载，仍会遗漏定义挂载时未预见的登录 shell 工具、宿主服务、凭据与设备，因此 agent 可能把 Docker 等宿主能力报告为不存在，或表现得与执行启动的用户不同。不受限制的访问这一具体要求满足已归档[宿主启动器移除决策](../../archived/simplification/2026-08-22-remove-host-web-launcher.md)所记录的重新引入条件。

## Decision

仓库提供 `start.sh`，作为 `run-docker.sh` 的直接宿主替代方案；不带命令调用时会安装或更新服务。它为当前检出安装一个系统级 `deepseek-harness.service`，systemd 则以执行安装的非 root 用户运行服务，并采用该用户的 home、登录 shell、主组与补充组。`/usr/local/libexec/deepseek-harness` 下 root 属主的启动器与代理文件使 systemd 执行避开 home 目录 SELinux 标签，而后端仍直接运行原检出。单个包装进程监督 Harness 后端与 Caddy，通过宿主 Tailscale 节点发布回环代理，并且只在后端、代理、属主授权和 tailnet HTTPS 探测全部通过后报告就绪。

Docker 与原生部署共用检出准备、profile 拒绝、Tailscale 身份解析、部署锁、身份代理探测和 `deployment/Caddyfile`。完成构建后，原生安装器只会在 Compose 标签证明两个运行中的 Harness 容器都属于当前检出时调用本地 Docker CLI。它会在检查原生端口前移除这些确切容器但保留命名 volume；其他检出的容器不受影响。纯原生宿主无需 Docker。接管有意保持单向：原生服务随后未能就绪时不会重建已移除的容器，诊断会要求操作者修正问题并重新安装。Docker 启动器会在停止组合前拒绝活动的原生 unit。

root 权限仅用于依赖检查、Ubuntu 或 Fedora 软件包安装、移除确切的自有 Docker 容器、原子安装 root 属主启动器与配置文件、systemd 操作、部署状态和 Tailscale 设置。运行时配置与部署状态必须是 root 属主、非符号链接的文件，并且组与其他用户都不可写。生命周期命令在修改或删除已安装 unit 与实时 Serve 路由前，会将其与部署状态比较。已有的无关 Tailscale operator、路由、Docker 标签与回环监听器都会触发快速失败。

## Alternatives considered

**仅使用 Docker 部署并增加挂载。** 否决：显式挂载仍要求预测每一种未来工具、服务、凭据、socket 与设备，无法满足与用户宿主环境等价的要求。

**恢复拥有独立策略的宿主启动器。** 否决：重复的构建、身份、就绪与路由逻辑会重现已归档移除决策指出的维护风险。共享部署辅助函数让两种执行模式保持一致。

**为 Harness、Caddy 与发布使用多个 systemd unit。** 否决：独立 unit 会让就绪、task-board 令牌所有权、失败传播与清理更复杂。单个通知型服务拥有完整运行时生命周期。

**把已发布 npm 包安装到私有服务目录。** 否决：部署要求直接执行当前检出，使本地插件、构建与更新成为服务来源。

## Consequences

agent 获得服务用户对文件、凭据、设备、宿主服务与登录 shell 的直接访问。补充组会被保留；用户属于 `docker` 组时，agent 可通过 Docker daemon 获得等同于宿主 root 的权限。因此 tailnet ACL 与仅限属主的 Caddy 路由仍是安全模型的一部分，而不只是网络便利功能。

托管路径要求 Linux、systemd、宿主 Tailscale 节点与 Caddy。Ubuntu 与 Fedora 安装过程会在版本检查前通过已配置的 APT 或 DNF 仓库补装缺失的 Caddy 包。启动器会临时遮蔽该包服务，再将其禁用并解除遮蔽，确保只有 `deepseek-harness.service` 拥有代理进程。其他工具仍由服务用户的登录 shell 管理。安装过程输出带实时耗时进度的具名阶段，除非设置 `DSH_VERBOSE=1`，否则隐藏成功命令的细节，并在失败时重放完整命令日志；随后在 systemd 就绪后返回；已启用的服务随后独立在后台持久运行。非交互 sudo 失败发生在部署变更之前，并指向交互调用命令。手动依赖指引也覆盖 Arch。原生与 Docker 部署不能同时占用受管理的端口与 Serve 路由。卸载会保留配置和所有权状态，供管理员检查或复用。

共享实现减少了策略漂移，但不会消除平台专项验证工作。在把任一发行版称为已完成人工认证之前，仍需完成 Ubuntu、Fedora 与 Arch 的安装、重启后恢复、更新、迁移、回滚与卸载 smoke。

## Verification

`scripts/start.spec.ts` 覆盖文档所述的零参数默认安装与 CLI 完成消息、简洁与详细命令输出、Ubuntu 与 Fedora 缺失 Caddy 安装及已有服务保留、真实 systemd unit 校验、不依赖 root PATH 的登录 shell Node 与 pnpm 解析、全新安装失败清理、端口变更拒绝、安装顺序、非 root unit 渲染、登录 shell 执行、更新停止与回滚、`Type=notify` 运行时监督、授权就绪、确切的自有 Docker 接管与无关容器保留、operator、路由、监听器、配置与 unit 所有权失败、诊断脱敏、生命周期清理，以及 Arch 依赖指引。`scripts/run-docker.spec.ts` 固定共享策略、镜像前构建、宿主 Docker 暴露与活动原生服务排除行为。Bash 语法校验覆盖两个启动器及其共享辅助脚本。Ubuntu 24.04 与 Fedora 42 容器分别安装其发行版 systemd 包，并由 `systemd-analyze verify` 接受渲染后的 unit；这只校验解析器可移植性，不代表服务启动。

当前容器化开发环境中没有真实 Ubuntu、Fedora 或 Arch systemd 宿主，因此本记录不声称已完成这些人工平台 smoke。

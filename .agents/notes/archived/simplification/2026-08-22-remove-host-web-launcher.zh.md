# Agent Note: 移除宿主机原生 Web 服务启动器

Status: implemented
Archived: 2026-08-24

[English](2026-08-22-remove-host-web-launcher.md) | 中文

## Problem

仓库包含两个机器部署工具，它们都会安装或消费源码检出、管理 Tailscale Serve 并公开 Web UI。宿主机原生路径还负责生成 systemd unit、写入 root 配置、更改 Tailscale operator、检查路由冲突，并维护专用测试工具。维护两个启动器会重复生命周期与安全敏感的部署行为。

## Decision

仓库以 `run-docker.sh` 作为机器部署工具，并移除 `run-web.sh`、其专用测试和根 README 说明。普通的 `pnpm dsh web` 命令仍是开发与诊断所用的前台宿主机原生路径。

该决策整合被移除启动器的动机与保证。宿主机服务提供重启持久性与宿主机工具直接访问，同时让 agent 进程保持非 root；特权操作仅限安装、systemd 与 Tailscale 配置，并且绝不覆盖现有 operator 或 Serve 路由。Docker 启动器会挂载所选 home、工作区、工具链与设备，并监督单一组合，因此这些保证不再足以证明维护平行实现的合理性。现有 systemd unit 属于机器外部状态，不会由仓库更新移除。

## Alternatives considered

**保留两个部署启动器。** 否决：每次构建、就绪、Tailscale、权限与清理变更都要继续维护两个独立实现与测试路径。

**弃用宿主机启动器但将其留在仓库中。** 否决：写入特权系统状态却不再维护的安装器比明确不存在更危险，而且继续保留意味着仍受支持。

**用更小的 systemd 模板替换。** 否决：unit 渲染不是困难部分；安全的用户选择、依赖准备、operator 所有权、Serve 路由所有权、就绪与卸载行为仍需维护代码。

## Consequences

仓库不再安装、管理或卸载持久化宿主机原生 Web 服务。先前安装的 unit 必须通过该机器的 systemd 与 Tailscale 管理移除；只删除检出不会清理外部状态。Docker 部署与前台 `pnpm dsh web` 仍然可用。

只有容器的显式挂载与设备访问无法满足具体宿主机原生需求时，才可重新引入宿主机服务。任何替代实现都必须保留非 root agent 执行、快速失败的 operator 与 Serve 路由所有权、确定性的就绪与清理，以及 Fedora 和 Ubuntu 验证。

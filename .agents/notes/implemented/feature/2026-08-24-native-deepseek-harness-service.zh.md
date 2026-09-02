# Agent Note: DeepSeek Harness 原生服务

Status: implemented

[English](2026-08-24-native-deepseek-harness-service.md) | 中文

## Problem

容器只能访问明确暴露给它的宿主路径、socket、设备与环境。即使 Harness 组合提供了大量挂载，仍会遗漏定义挂载时未预见的登录 shell 工具、宿主服务、凭据与设备，因此 agent 可能把 Docker 等宿主能力报告为不存在，或表现得与执行启动的用户不同。不受限制的访问这一具体要求满足已归档[宿主启动器移除决策](../../archived/simplification/2026-08-22-remove-host-web-launcher.md)所记录的重新引入条件。原生服务还必须拒绝使用同一 Harness home 的手工 Web 进程，因为不同监听端口并不能隔离它们共享的 session 文件。

## Decision

仓库提供 `start.sh`，作为 `run-docker.sh` 的直接宿主替代方案；不带命令调用时会安装或更新服务。它为当前检出安装一个系统级 `deepseek-harness.service`，systemd 则以执行安装的非 root 用户运行服务，并采用该用户的 home、登录 shell、主组与补充组。`/usr/local/libexec/deepseek-harness` 下 root 属主的启动器与代理文件使 systemd 执行避开 home 目录 SELinux 标签，而后端仍直接运行原检出。在安装器或托管运行时启动后端之前，它会扫描同一用户的 Linux `/proc` 记录，查找显式 `DSH_HOME`（未设置时为 `HOME/.dsh`）解析到服务 home 的其他 `dsh web` 命令。发现匹配时，启动会失败并报告其 PID 与停止指引；启动器绝不会向这个非自有进程发送信号。单个包装进程监督 Harness 后端与 Caddy。显式或已保存的 VPN provider 控制安装。两者均不存在时，安装器会优先于 Tailscale 选择已连接的 NetBird 网络；两者均未连接时，安装器会在变更部署前失败。Tailscale 模式通过宿主 Tailscale 节点发布回环代理；NetBird 模式将 Caddy 绑定到宿主 NetBird 地址，并使用 NetBird ACL 与 Harness 浏览器 cookie。就绪探测会等待后端、代理、所选授权路径与所选 VPN 可达。它在私有 systemd 运行时目录中捕获进程启动 URL，并且只把其中的令牌交给 Caddy。对于没有 Harness cookie 的干净根路径请求，Tailscale 模式要求 Serve 注入的属主身份；NetBird 模式直接用隐藏令牌交换普通浏览器 cookie。Caddy 会保留传入的 Host authority，使 NetBird 端口在签名 cookie、Host 检查与浏览器 Origin 检查中保持一致。每个信任 Tailscale 身份 header 的 matcher 还会要求 Tailscale 模式，因此 NetBird peer 无法通过客户端提供的 header 选择其属主或 task-token 路由。就绪探测使用同一 cookie 执行当前 `settings/describe` 属主检查。

Docker 与原生部署共用检出准备、profile 拒绝、VPN 身份解析、部署锁、身份代理探测和 `deployment/Caddyfile`。完成构建后，原生安装器只会在 Compose 标签证明两个运行中的 Harness 容器都属于当前检出时调用本地 Docker CLI。它会在检查原生端口前移除这些确切容器但保留命名 volume；其他检出的容器不受影响。纯原生宿主无需 Docker。接管有意保持单向：原生服务随后未能就绪时不会重建已移除的容器，诊断会要求操作者修正问题并重新安装。Docker 启动器会在停止组合前拒绝活动的原生 unit。

root 权限仅用于依赖检查、Ubuntu 或 Fedora 软件包安装、移除确切的自有 Docker 容器、原子安装 root 属主启动器与配置文件、systemd 操作、部署状态和所选 VPN 设置。运行时配置与部署状态必须是 root 属主、非符号链接的文件，并且组与其他用户都不可写。部署状态会记录已安装的 VPN provider、检出、服务用户、端口与 Serve 回环目标。执行 `install` 时，仅包含其他四个所有权字段的状态文件会从匹配的 root 属主 unit 推导缺失的 provider，并在更新成功后重写。生命周期命令在修改或删除已安装 unit 与实时 Serve 路由前，会使用该 provider 记录进行比较。路由移除会重复发布时使用的持久 `--bg` 模式，并在 Tailscale 命令失败后重新检查所有权：路由已经不存在时清理完成，路由仍然存在或已被替换时则快速失败。更新 EXIT handler 不依赖函数局部状态，并会在此类后期失败后重新启动已停止的安装。除 `install` 外的命令会拒绝缺失 provider 的状态，当配置中的 provider 或端口不一致时，`start` 与 `restart` 会拒绝执行，直至 `install` 一并更新 unit、状态与自有路由。当 root 属主状态与已安装 unit 识别出受管理服务，而其记录的检出已不存在时，`install` 会在停止活动服务前准备调用方检出，随后重写 unit 与状态；其他生命周期命令会报告过期检出并指引操作者执行 `install`。仍然存在的其他已记录检出继续触发快速失败，无关的 VPN operator、路由、Docker 标签与回环监听器同样如此。

## Alternatives considered

**仅使用 Docker 部署并增加挂载。** 否决：显式挂载仍要求预测每一种未来工具、服务、凭据、socket 与设备，无法满足与用户宿主环境等价的要求。

**恢复拥有独立策略的宿主启动器。** 否决：重复的构建、身份、就绪与路由逻辑会重现已归档移除决策指出的维护风险。共享部署辅助函数让两种执行模式保持一致。

**两个 VPN 均已连接时优先选择 Tailscale。** 否决：自动选择会在 NetBird 可用时把它作为默认值；显式或已保存的 provider 仍具有最高优先级。

**为 Harness、Caddy 与发布使用多个 systemd unit。** 否决：独立 unit 会让就绪、task-board 令牌所有权、失败传播与清理更复杂。单个通知型服务拥有完整运行时生命周期。

**检出删除后要求手工清理 systemd。** 否决：root 属主状态与匹配 unit 已经能识别受管理安装，而手工删除会绕过其路由与所有权检查。自动接管只适用于记录检出不存在的情况，仍然存在的其他检出继续受到保护。

**把已发布 npm 包安装到私有服务目录。** 否决：部署要求直接执行当前检出，使本地插件、构建与更新成为服务来源。

**把已配置端口视为没有其他 Harness 活动的证明。** 否决：手工 Web 进程可以选择其他端口，同时继续使用同一 `DSH_HOME` 与 session 文件。

**终止检测到的手工 Web 进程。** 否决：托管启动器并不拥有该进程。它只报告 PID，并把终止操作留给操作者。

## Consequences

agent 获得服务用户对文件、凭据、设备、宿主服务与登录 shell 的直接访问。补充组会被保留；用户属于 `docker` 组时，agent 可通过 Docker daemon 获得等同于宿主 root 的权限。因此 VPN ACL 与 Caddy 授权路径仍是安全模型的一部分，而不只是网络便利功能。宿主同时连接两个网络时，自动选择会使用 NetBird；其访问控制依赖 NetBird ACL 与 Harness 浏览器 cookie，而不是 Tailscale 用户身份。操作者可以显式配置 Tailscale。

托管路径要求 Linux、systemd、已连接的宿主 Tailscale 或 NetBird 节点与 Caddy。Ubuntu 与 Fedora 安装过程会在版本检查前通过已配置的 APT 或 DNF 仓库补装缺失的 Caddy 包。启动器会临时遮蔽该包服务，再将其禁用并解除遮蔽，确保只有 `deepseek-harness.service` 拥有代理进程。当 pnpm 缺失但 Corepack 可用时，启动器会激活固定的 pnpm 版本；其他工具仍由服务用户的登录 shell 管理。安装过程输出带实时耗时进度的具名阶段，除非设置 `DSH_VERBOSE=1`，否则隐藏成功命令的细节，并在失败时重放完整命令日志；随后在 systemd 就绪后返回；已启用的服务随后独立在后台持久运行。安装过程与 `status` 都只打印干净的公开 authority；原生身份代理把进程令牌保留在内部。非交互 sudo 失败发生在部署变更之前，并指向交互调用命令。手动依赖指引也覆盖 Arch。原生与 Docker 部署不能同时占用受管理的端口与 Serve 路由。同一用户中使用服务 home 的 Web 进程也会阻止启动，不受其端口影响；使用其他 Harness home 的 Web 进程保持独立。卸载会保留配置和所有权状态，供管理员检查或复用。

共享实现减少了策略漂移，但不会消除平台专项验证工作。在把任一发行版称为已完成人工认证之前，仍需完成 Ubuntu、Fedora 与 Arch 的安装、重启后恢复、更新、迁移、回滚与卸载 smoke。

## Verification

`scripts/start.spec.ts` 覆盖文档所述的零参数默认安装与 CLI 完成消息、简洁与详细命令输出、Ubuntu 与 Fedora 缺失 Caddy 安装及已有服务保留、真实 systemd unit 校验、不依赖 root PATH 的登录 shell Node 与 pnpm 解析、Corepack pnpm 激活、全新安装失败清理、缺失检出恢复及构建先于停服的顺序、从 Tailscale 与 NetBird unit 恢复缺失 provider、provider 与端口变更拒绝、优先 NetBird 的自动 provider 选择、Tailscale 路由并发清理与后期失败重启、Tailscale 到 NetBird 的清理、按已记录 provider 卸载、安装器与托管运行时入口对同 home Web 进程的拒绝且不终止进程以及对不同 home 的放行、安装顺序、非 root unit 渲染、登录 shell 执行、更新停止与回滚、`Type=notify` 运行时监督、启动 URL 捕获、无令牌属主 cookie 交换、授权就绪、确切的自有 Docker 接管与无关容器保留、operator、路由、监听器、配置与 unit 所有权失败、诊断脱敏、生命周期清理，以及 Arch 依赖指引与带 Tailscale matcher provider 限制、保留非默认端口 authority 的 NetBird 直接 mesh 启动。`scripts/run-docker.spec.ts` 固定共享策略、镜像前构建、宿主 Docker 暴露与活动原生服务排除行为。Bash 语法校验覆盖两个启动器及其共享辅助脚本。Ubuntu 24.04 与 Fedora 42 容器分别安装其发行版 systemd 包，并由 `systemd-analyze verify` 接受渲染后的 unit；这只校验解析器可移植性，不代表服务启动。

宿主 Caddy smoke 在非默认 NetBird 端口上完成启动令牌与 cookie 交换，并从 `settings/describe` 收到 HTTP 200。当前容器化开发环境中没有真实 Ubuntu、Fedora 或 Arch systemd 宿主，因此本记录不声称已完成这些人工平台 smoke。

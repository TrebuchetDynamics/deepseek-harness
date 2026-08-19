# Agent Note: Web 浏览器 e2e 车道的可重现 Docker 与 CI 作业

Status: implemented

[English](2026-08-19-reproducible-browser-e2e-docker.md) | 中文

## Problem

[无密钥 Web 浏览器 e2e 车道](2026-07-24-web-gui-browser-e2e-lane.md)（`pnpm run test:web`）驱动真实 Chromium，因此需要可用的浏览器渲染器，以及 lockfile 中 Playwright Chromium 所依赖的 OS 库。贡献者的环境——最常见的是免 root 的开发容器——可能两者都没有，于是即便仓库其余测试全部通过，该车道在那里也无法运行。原生 CI gate（`.github/workflows/ci.yml`）在 runner 上预置 Chromium，证明了车道在 CI 中可用，但贡献者仍没有可本地运行的方式，CI 自身也没有任何东西去验证一个可重现、预构建的浏览器运行时。

## Decision

Phase 1 交付一个可重现的 Docker 运行时，以及一个专门证明它的 CI 作业。`docker/browser-e2e/` 是工具链镜像（node 24-bookworm + pnpm + `playwright install --with-deps` 安装精确 lockfile 解析的 Chromium，setuid `chrome_sandbox`、Bubblewrap、全局可写 `/pnpm-store`）。它不内嵌检出：`docker/browser-e2e/run.sh` 与 CI 作业将仓库以读写方式挂载到 `/workspace`，并在其中运行 `pnpm install --frozen-lockfile && pnpm run test:web`。浏览器字节与 OS 库一次性预置于以 `pnpm-lock.yaml` 为键的层；工作区安装按次从当前检出进行，因此镜像保持确定性，而无需装入一棵易变的树。包装脚本以调用者 uid 和隔离 bridge 网络启动。完整车道的产品测试会创建嵌套文件系统沙箱，因此需要显式 `--privileged`；自定义 smoke 命令保持非特权。`--host-network` 单独用于访问仅主机可见的服务。

`.github/workflows/browser-e2e-docker.yml` 构建镜像（GitHub 托管层缓存）并在其中无密钥地运行车道（`DSH_SNAPSHOT=replay`），绝不运行 `record` 或 `refresh`，与 [browser-snapshot CI gate 政策](2026-07-30-web-browser-snapshot-ci-gate.md) 一致。

### Scaffold 边界

这是一次仅配置与文档的变更：它新增 Dockerfile、运行包装脚本、workflow、车道 README 说明与本文档。它不修改任何产品或测试源码；尤其是它不新增启动开关，浏览器仍以标准 `chromium.launch()` 沙箱默认启动。镜像与包装脚本已在本地执行。完整车道达到 253 个浏览器测试通过；聚焦 Docker 运行验证了 Bubblewrap 后台任务与移动端抽屉场景。现有会话滚动断言仍由其聚焦车道负责。

## Alternatives considered

**官方 `mcr.microsoft.com/playwright` 基础镜像。** Phase 1 拒绝：lockfile 中的 Playwright 以插入符范围浮动（`^1.49.0`），将官方镜像钉到单一版本要么跟随浮动依赖（漂移），要么把仓库钉死（churn）。从真实 lockfile 执行 `install --with-deps` 构建，使浏览器与贡献者及原生 gate 安装的完全一致，零漂移成本。

**内嵌完整冻结检出 + 构建的镜像。** 拒绝：任何源码变更都会强制重建，破坏迭代循环，并让 CI 在每个 PR 上丢失缓存。挂载模型复用贡献者常规的 `pnpm install` 流程，并把 node_modules 留在镜像之外。

**复用原生 consumer 作业承担 Docker 路径。** 拒绝：要点正是证明 *Docker 运行时* 本身。独立作业是 Dockerfile 损坏、Playwright/Chromium 组合漂移、或缺失 OS 库的哨兵——这些原生 gate 都抓不到。

**默认使用网络模式/特权。** 拒绝：车道是封闭的，因此默认隔离桥接既更可重现也更安全；完整主机访问保持为显式按需旗标，因为这里的"完整主机访问"指"场景需要时可达仅主机可见的服务"，而非沙箱松懈。

## Testing

`docker/browser-e2e/run.sh` 以只读回放模式运行车道，并如同原生车道一样在任何 pageerror 或 fixture 漂移时失败——车道自身的断言就是行为测试，容器不再新增任何断言。CI 作业 `.github/workflows/browser-e2e-docker.yml` 是可重现路径的验证。`run.sh` 通过语法检查；镜像成功构建，Chromium 以调用者 uid 启动，移动端抽屉场景通过，显式特权下的聚焦嵌套沙箱浏览器测试也通过。

## Consequences

免 root 主机上的贡献者获得了一条命令、可重现地运行真实浏览器车道的方式，CI 也独立证明服务他们的容器镜像。接受的成本：镜像是与原生 gate 分开的一层 Chromium 预置（首次运行时构建，其后缓存）；挂载运行会把 `node_modules` 写进贡献者的检出（被 git 忽略，与常规本地安装一致）；以及 scaffold 的首次真实执行是 CI 本身而非作者，因此各主机内核上的 SUID 沙箱路径仍有待 runner 实际运行时观察。

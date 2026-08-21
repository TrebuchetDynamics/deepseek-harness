# 可重现的浏览器 e2e（Docker）

[English](README.md) | 中文

[真实浏览器 Web e2e 车道](../../apps/web/tests/README.zh.md)（`pnpm run test:web`）
用真实 Chromium 驱动整套组装好的 Web 链路。它需要一个可用的 Chromium 渲染器，
以及标准 Playwright Chromium 依赖的 OS 库。贡献者的环境——通常是免 root 的开发
容器——可能两者都没有，这会彻底阻断该车道，即便仓库其余测试都正常。

`docker/browser-e2e` 是 Phase 1 的答案：一个可重现的容器镜像，内置仓库 lockfile
解析出的精确 Chromium 构建及其系统库，使车道可在任意具备 Docker 的环境运行。它
与托管 CI consumer 作业已在用的做法（`.github/workflows/ci.yml` 中的 "Install
Playwright Chromium and hosted dependencies"）一致，并由专属 CI 作业
（`.github/workflows/browser-e2e-docker.yml`）自行验证。

## 文件

| 路径                     | 用途                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `Dockerfile`             | 工具链镜像：node 24 + pnpm + lockfile Chromium + OS 库（setuid 沙箱） |
| `run.sh`                 | 构建镜像并针对当前检出运行 `test:web`                                  |
| `README.md`              | 本文件                                                               |

## 工作原理

- 镜像**不**内嵌检出。`run` 脚本与 CI 作业将仓库以读写方式挂载到 `/workspace`，
  并在其中运行 `pnpm install --frozen-lockfile && pnpm run test:web`。浏览器字节
  与 OS 库一次性预置于以 `pnpm-lock.yaml` 为键的构建层；工作区安装则按次从挂载
  （当前）检出进行。
- Chromium 位于 `/opt/ms-playwright`（`PLAYWRIGHT_BROWSERS_PATH`）；其 OS 库在
  构建时由 `playwright install --with-deps` 安装。
- 镜像安装 setuid Chromium 与 Bubblewrap 辅助程序。容器以调用者 uid 运行；完整
  车道需要 `--privileged`，因为产品测试会创建嵌套文件系统沙箱。
- 包装脚本将调用者的 pnpm store 挂载到相同绝对路径，使重复运行复用下载内容，同时避免让主机 `node_modules` 指向仅容器可见的 store。

## 运行

```sh
docker/browser-e2e/run.sh --privileged
```

这会构建镜像（首次构建较慢——需预置 Chromium），然后以只读回放模式运行车道。默认
命令为：

```sh
pnpm install --frozen-lockfile && pnpm run test:web
```

所有环境变量透传与 `DSH_SNAPSHOT` 默认值均来自 `run.sh`；参见其帮助
（`docker/browser-e2e/run.sh --help`）。

### 模式

`DSH_SNAPSHOT` 选择车道模式，与在 Docker 之外完全一致：

- `replay`（默认）——无密钥；与已提交的 golden 比较。
- `record`——驱动真实模型；需要 `DEEPSEEK_API_KEY`（可选用
  `DEEPSEEK_BASE_URL`），两者均由 `run.sh` 透传。
- `refresh`——无密钥地重写已提交的 aria golden。

CI 绝不运行 `record` 或 `refresh`；其强制 `replay`（见
[browser-snapshot CI gate](../../.agents/notes/implemented/testing/2026-07-30-web-browser-snapshot-ci-gate.zh.md)）。

## 容器特权与网络

完整车道会创建嵌套产品沙箱，因此默认命令在没有显式 `--privileged` 时拒绝启动。
自定义 smoke 命令保持非特权，除非调用者主动开启。容器仍使用 Docker bridge 网络；
`--host-network` 单独用于访问仅主机可见的服务。

## CI

`.github/workflows/browser-e2e-docker.yml` 构建镜像（使用 GitHub 托管的层缓存），
并在可信分支推送、定时任务或显式 dispatch 后，以特权容器无密钥运行车道。PR 继续
使用原生浏览器门禁。它是可重现 Docker 运行时本身的哨兵：Dockerfile 损坏、
Playwright/Chromium 组合漂移、或缺失 OS 库都会在这里先行失败。它作为补充，而不是
取代 `ci.yml` 中原生的 browser-snapshot gate。

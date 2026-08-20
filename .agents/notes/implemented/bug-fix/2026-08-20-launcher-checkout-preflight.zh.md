# Agent Note：run-docker.sh 预检检出的安装与构建状态

Status: implemented

[English](2026-08-20-launcher-checkout-preflight.md) | 中文

## 问题

容器通过自己的 `pnpm dsh` 启动挂载的检出，它要解析仓库的 `node_modules` 与已构建的浏览器产物。`run-docker.sh` 只校验 `DSH_REPO` 是一个目录，于是全新克隆的检出、或拉取/合并后 lockfile 变化或新增 client 包的检出，会一路走到 `docker compose up`，然后在数秒后使 `dsh` 容器崩溃：`dsh web` 以 `client bundles not found; run pnpm run build before launch` 退出（`node_modules` 缺失时则是模块解析失败），健康检查永远不通过，用户只看到 Compose 的 `Container docker-dsh-1 Error dependency...`——真正的错误埋在启动器从未展示的容器日志里。这在实际中发生过：合并上游 0.1.0-rc.8（新增四个 client 包）之后，启动器构建镜像花了两分钟，然后失败，且没有任何指向原因的线索。

## 决策

启动器为自己制造的先决条件负责：既然是它启动检出，它就在构建或启动任何东西之前校验检出可启动。在 `DSH_REPO` 存在性检查之后，一次 `node -e` 预检依次测试：`node_modules` 存在（否则"运行 `pnpm install`"）、`apps/web/dist/index.html` 存在（否则"运行 `pnpm run build`"）、以及每个 manifest 携带 `dsh.client` 块的 `packages/client/*` 包都有 `lib/client.js`（否则"运行 `pnpm run build`"并点名缺失的包——正是缺失时会导致启动崩溃的那批）。任何发现都以 `error:` 命名仓库路径与确切命令后退出；就绪的检出不输出任何内容。

藏在 Compose 依赖消息后的失败会被直接呈现。当 `compose up` 失败、健康检查门控的代理错过可配置的就绪期限，或任一身份检查请求失败时，启动器先打印 `compose ps -a` 以及 `dsh` 与 `auth-proxy` 的最后 30 行日志再退出；HTTP 策略不匹配时会报告两个实际状态码。`DSH_STARTUP_TIMEOUT` 默认为 90 秒，使冷启动的 `pnpm dsh` 加 20 秒启动期和 30 秒健康检查间隔不会再与固定的 10 秒期限竞争。

## 考虑过的替代方案

**缺失时自动运行 `pnpm install`/`pnpm run build`。** 否决：对宿主树的分钟级副作用（网络拉取、产物写入）属于显式的用户动作；启动器既定模式是带确切命令快速失败。

**只检查 `node_modules`，让容器报错去提构建。** 否决：容器的报错确实给出了要在某个目录里运行的命令——但发现它需要读启动器从未展示的容器日志，而这正是要修复的问题。

**只抽查一个固定 bundle（比如 `ui-renderer/lib/client.js`）。** 否决：合并可以新增任意数量的 client 包；检查必须遍历 manifest 而不是抽样一个路径，否则下一次合并重新引入崩溃。

**保留 10 秒探测窗口。** 作为同类症状的一部分一并否决：慢但健康的启动会以与崩溃启动完全相同的无用消息退出。

## 后果

全新克隆会在任何镜像构建之前得到 `error: <repo> is not ready to boot: run 'pnpm install' there first`；合并后的树得到同样处理并点名缺失的 client 包；执行 `pnpm install && pnpm run build` 后，rc.8 检出返回 HTTP 200。stub 宿主场景覆盖未安装、无 web dist、client bundle 过期、Compose 启动失败、代理策略不匹配，以及两个服务的诊断输出。

权衡：预检在启动路径上增加一次 `node` 调用（node 本就是硬性先决条件）；预检无法解析的 package.json 会让启动以解析错误而非精选消息中止；检查把每个 `dsh.client` 包都当作必需，即使未来某个 profile 不包含其中一些——误报的代价是一次 `pnpm run build`，漏报的代价是原来的静默崩溃，因此检查从严。

# Agent Note: run-docker.sh 在启动容器前安装并构建检出

Status: implemented

[English](2026-08-20-launcher-checkout-preflight.md) | 中文

## 问题

容器通过自己的 `pnpm dsh` 启动挂载的检出，它要解析仓库的 `node_modules` 与已构建的浏览器产物。因此，全新检出或改变依赖项或 client 包的合并可能成功构建容器镜像，随后却在启动时因模块解析失败或缺少 client bundle 而崩溃。Compose 只报告健康依赖失败，可操作的错误仍留在容器日志中。

## 决策

启动器先校验 `DSH_REPO` 是带 pnpm lockfile 与 `dsh` 包脚本的 Git 根目录。然后它在准备检出前停止现有组合，因此 pnpm 替换依赖链接或构建产物时，没有运行中的进程读取它们。随后每次启动都在 `DSH_REPO` 中运行 `pnpm install --frozen-lockfile` 与 `pnpm run build`；任一命令失败都会带检出路径终止启动。构建后的检查要求存在 `node_modules`、`apps/web/dist/index.html`，以及每个 manifest 携带 `dsh.client` 的 `packages/client/*` 包中的 `lib/client.js`，因此，成功退出但遗漏运行时产物的自定义构建也会在 Compose 启动前失败。

藏在 Compose 依赖消息后的失败会被直接呈现。当 `compose up` 失败、健康检查门控的代理错过可配置的就绪期限，或任一身份检查请求失败时，启动器会打印 `compose ps -a` 以及 `dsh` 与 `auth-proxy` 的最后 30 行日志，然后退出；HTTP 策略不匹配时会报告两个实际状态码。`DSH_STARTUP_TIMEOUT` 默认为 90 秒，使冷启动的 `pnpm dsh` 加健康检查调度不会与过短的固定期限竞争。

## 考虑过的替代方案

**只报告陈旧检出所需的命令。** 否决：运行启动器应当产出它所需的可运行检出，而预检无法从 `node_modules` 仍然存在可靠判断依赖项变化。

**存在 `node_modules` 时跳过安装。** 否决：pnpm 的 lockfile 安装是已有的幂等同步机制；在 shell 中重复实现其部分新鲜度逻辑可靠性更低。

**信任构建的零退出状态。** 否决：`DSH_REPO` 可配置，其构建脚本可能不产出 `dsh web` 消费的浏览器产物；窄范围产物检查能在容器重启循环前给出失败。

## 后果

一次启动器调用会同步依赖项、重新构建检出、构建镜像、启动组合、验证代理授权并发布 Tailscale Serve。聚焦的 stub 宿主测试验证检出安装与编译先于镜像构建。

每次启动都有停机时间供 pnpm 检查依赖项并编译源代码，也会把正常安装与构建输出写入挂载的检出。准备失败会让现有服务保持停止。这些成本是有意的：相比推断某次合并是否留下陈旧的依赖链接或生成产物，启动器优先保证完整启动，并且绝不让旧进程继续读取正在重建的检出。

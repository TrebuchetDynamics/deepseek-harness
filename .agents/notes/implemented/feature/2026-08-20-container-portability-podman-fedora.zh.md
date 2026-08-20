# Agent Note：Docker 组合在 podman 与 Fedora 宿主上无需调整即可运行

Status: implemented

[English](2026-08-20-container-portability-podman-fedora.md) | 中文

## 问题

该组合假设了 rootful Docker 守护进程、Debian/Ubuntu 形态的宿主，以及一个特定用户。三个假设在 Fedora 上、以及在用户 uid 不是 1000 的任何宿主上都会失败：

- 启动器硬性要求 `docker` 可执行文件并以 `docker compose` 方式调用。Fedora 默认搭载 podman，很多用户以 rootless 方式运行它；即使 podman 能运行同一份 Compose 文件，启动器也拒绝启动。
- Fedora 默认启用 SELinux enforcing。容器进程运行在 `container_t` 标签下，对携带用户 home 标签的绑定挂载路径默认拒绝访问——本组合的每个挂载（整个 home、JDK、Android SDK）都不可读。
- 镜像与入口脚本硬编码了 uid 1000（`setpriv --reuid=1000 --regid=1000 --init-groups`、构建期 `chown -R 1000:1000`）。rootless podman 下默认用户命名空间把容器 uid 1000 映射到无关的 subuid，agent 在挂载 home 中创建的文件在宿主上不属于调用用户；用户 uid 不是 1000 的宿主则得到一个无法写自己 home 的进程。

## 决策

运行时检测取代了 `docker` 硬性要求。默认 `DSH_CONTAINER_RUNTIME=auto` 模式下，只有当 Docker 不是 podman 兼容 shim、Compose 插件可用且 `docker info` 能访问引擎时，Docker 才优先；否则启动器尝试可达的 podman 引擎与 `podman compose`，并回退到 `podman-compose` 提供方。`DSH_CONTAINER_RUNTIME=docker|podman` 可明确选择一个运行时，并以被拒候选的原因失败。检测到的命令数组用于所有 Compose 调用。启动器在非 Linux 宿主上提前失败，并要求 `PATH` 上存在 `node`、`curl`、`tailscale`、`flock` 与 `readlink`；其宿主网络、进程锁和 GNU 路径处理都依赖 Linux。Tailscale 命令或 JSON 失败会产生专门错误，而不是后续误报 MagicDNS 为空。

容器进程降权到挂载宿主 home 的属主 uid/gid（`stat -c '%u %g'`，`stat` 不可用时带警告回退到调用用户），以 `DSH_UID`/`DSH_GID` 导出并经 Compose 传入入口脚本。入口脚本为独立 `docker run` 保留默认值 1000，在启动 `tailscaled` 之前把 Tailscale 状态目录 chown 到该 uid/gid，并用 `setpriv --clear-groups` 而非 `--init-groups` 降权，因为任意 uid 在镜像中没有 passwd 条目。

SELinux 在基础 compose 文件中一次性处理：两个服务都设置 `security_opt: [label=disable]`。替代方案——挂载加 `:z` 重打标签——会在宿主上改写整个挂载 home 中每个文件的安全标签；对这两个机器本地服务禁用标签是安全方向。Docker 在非 SELinux 宿主上把 `label=disable` 视为 no-op，基础文件因此保持运行时中立。

仅在 rootless podman 下，启动器生成的每次启动 override 向 `dsh` 服务追加 `userns_mode: keep-id`：用户命名空间把调用 uid 一一映射，容器内的 `DSH_UID` 即宿主上的同一 uid。rootless 检测读取 `podman info --format '{{.Host.Security.Rootless}}'`。`keep-id` 是 podman 专属取值，Docker 守护进程在运行时拒绝它，因此它只能经由生成的 override 到达 Compose，绝不进入基础文件。rootful podman 与 Docker 直接使用宿主 uid，无需映射。

`dsh` 服务还设置 `init: true`：入口脚本 exec 掉了自己的 shell，孤儿进程（`pnpm`/`tsx` 进程树、`tailscaled`）否则会累积成僵尸进程；docker-init 与 podman 的 catatonit 都会收割它们。

同一变更中的 Dockerfile 改进：npm 缓存挂载（`--mount=type=cache,target=/root/.npm`）让约 90 MB 的全局安装下载在重建之间保留，且不进入镜像层（原来的 `rm -rf ~/.npm` 会清掉缓存挂载，因此删除）；OCI 注解（`org.opencontainers.image.*`，版本取自 `DSH_VERSION`）让构建出的镜像可被 inspect；移除了 `VOLUME` 声明——状态由 Compose 经 `tsstate` 具名卷持有，匿名卷在每次独立重启时悄悄累积。启动器默认执行普通缓存构建；`DSH_BUILD_NO_CACHE=1` 可明确要求干净重建，同时仍保留 npm 缓存挂载。

## 考虑过的替代方案

**为 Fedora 用户写文档"安装 Docker"。** 否决：rootless podman 是 Fedora 默认，且满足本组合的全部需求（host 网络在 rootless 下共享宿主网络命名空间、非特权端口、绑定挂载）；强迫安装 Docker 守护进程与系统无关性的立场相悖。

**用 `:z`/`:Z` 挂载标志处理 SELinux。** 否决：组合把用户整个 home 读写挂载；`:z` 会把宿主上每个文件重打标签为 `container_file_t`，破坏容器之外用户的 SELinux 策略预期，`:Z` 对双服务共享挂载是错的。

**以固定容器用户运行并在挂载点重映射。** 否决：绑定挂载不存在挂载期 uid 重映射；所有权由写入进程决定，进程本身必须以宿主用户的 uid 运行。

**把 `userns_mode: keep-id` 放进基础 compose 文件。** 否决：Docker 守护进程在容器启动时拒绝该取值；该设置只能到达 podman 运行，因此属于 podman 检测后的 override。

**对 `auth-proxy` 服务也应用 `keep-id`。** 否决：Caddy 只读一个只读 Caddyfile 并绑定非特权回环端口；它不写任何东西，uid 映射无关紧要。

## 后果

Fedora 宿主以 rootless podman 运行 `./run-docker.sh` 无需任何配置：启动器选择 `podman compose`，生成 `keep-id` override，两个服务都在禁用 SELinux 标签下运行，agent 在挂载 home 中的文件属于调用用户。rootful Docker 与 rootful podman 行为不变，除了 `init: true`（僵尸进程收割）与 uid 现在跟随 home 属主而非镜像硬编码的 1000——在原机器上两者都是 uid 1000，可观察差异只有 chown 与 `--clear-groups` 机制，不是结果所有权。

权衡：`podman compose` 需要提供方二进制，且（对 `docker-compose` 提供方）需要运行中的 `podman.socket`——README 的 Fedora 说明给出三条安装命令；rootless podman 下 `restart: unless-stopped` 只有在 `loginctl enable-linger` 之后才能在注销后存活，同样有文档。自动选择会拒绝把 `podman-docker` 兼容 shim 当作 Docker，并选择真实 podman 引擎，从而保留 rootless 检测；含糊安装仍可明确覆盖运行时。`label=disable` 移除了这两个服务的 SELinux 限制——可接受，因为这些服务是机器本地、回环绑定，且按设计已持有 home 的读写权限；它们失去的限制并非组合所依赖的。不带 Compose 的独立 `docker run` 不再经匿名卷持久化 Tailscale 状态；Compose 运行经 `tsstate` 保留。

验证使用仓库外 stub 宿主覆盖 rootless 与 rootful podman、提供方缺失、Docker 引擎失败后回退 podman、`podman-docker` shim 检测、明确运行时选择、缓存与干净构建、孤儿清理、启动诊断、端口校验、缺少 `stat` 以及完全没有运行时。入口脚本与 Dockerfile 检查固定了 uid 无关的 `setpriv` 降权、chown 先于 `tailscaled` 的顺序，以及 label/cache/VOLUME 决策。真实 Compose v5.5.0 渲染覆盖 `init`、`security_opt`、`DSH_UID`/`DSH_GID` 插值与 `userns_mode` 合并（基础渲染中不存在，rootless override 下存在）。

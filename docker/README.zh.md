# 通过 Tailscale 提供服务的 Docker 版 DeepSeek Harness

[English](README.md) | 中文

这个个人 fork 工具在容器中运行已发布的 DeepSeek Harness Web GUI（`dsh web`），并让它访问宿主的仓库；已启用或已安装时，还可访问宿主 Docker、Flutter、Android、Java 和 USB 设备。

如需直接访问用户登录环境中的全部工具与凭据，[`start.sh`](../start.sh) 提供宿主原生 systemd 替代方案。两个启动器共用身份代理与部署锁；所有权检查会阻止它们同时占用相同端口或 Tailscale Serve 路由。详见[原生部署参考](../deployment/README.zh.md)。

## 为什么使用回环地址与 Tailscale

`dsh web` 绑定 `127.0.0.1`，因为它的 API 可以执行工具和 shell 命令。Docker 组合保留这项限制，不发布容器端口，也不把应用绑定到网络接口。

宿主模式包含三跳：宿主 Tailscale Serve 终止 tailnet HTTPS，只有回环地址可访问的 Caddy 代理授权来自一个 Tailscale 登录的配置请求，容器化 Harness 则监听另一个回环端口。Tailscale Serve 会剥除客户端提供的身份头，并提供已认证的 `Tailscale-User-Login`；Caddy 保留浏览器 authority，仅为已配置属主转发特权 RPC 路径，并对访问相同路径的其他身份返回 403。其他请求保留 tailnet authority，并继续经过 Harness 浏览器信任与会话认证检查。

Harness 的 `--trusted-host` 选项是 DNS rebinding 与跨站栅栏，而不是认证机制。tailnet ACL 控制 GUI 访问。Caddy 规则把设置、凭据、模型发现、preset 管理、原生宿主操作和 Remote SSH 限制给 `TAILSCALE_OWNER`，但所有获准访问 GUI 的 tailnet 用户都能通过普通 agent 工具操作已挂载的宿主文件。

## 文件

| 路径                 | 用途                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `../Dockerfile`      | 包含已发布 `@deepseek-ai/dsh` CLI 的运行时镜像                          |
| `dsh-entrypoint.sh`  | 启动 `dsh web`、暴露已挂载工具链，并可选择加入由容器持有的 tailnet 节点 |
| `docker-compose.yml` | 宿主网络组合、宿主开发环境挂载、USB 访问和代理                          |
| `../deployment/Caddyfile` | 为仅限属主的配置 RPC 提供共享回环身份代理                           |
| `../run-docker.sh`   | 发现宿主工具链、构建、启动、检查并发布组合                              |
| `../.dockerignore`   | 排除不需要的构建上下文文件                                              |
| `browser-e2e/`       | Web 浏览器 e2e 车道（`pnpm run test:web`）的可重现 Chromium 运行时      |
| `browser-e2e/run.sh` | 构建该运行时并针对当前检出运行车道                                      |

## 构建

```sh
docker build -t dsh-tailscale:local -f Dockerfile .
```

镜像从 npm 安装已发布的 `@deepseek-ai/dsh` 包、其运行时对等包、用于 profile 插件管理的 pnpm、Docker 28 客户端及其维护中的 CLI 插件、带 pip、venv 支持、头文件及两个命令名的 Python 3，以及供原生构建使用的 GCC、G++、make 与 pkg-config。镜像不会运行 Docker daemon。`DSH_VERSION` 默认为 `0.1.1-rc.2`，`PNPM_VERSION` 则与仓库的 `packageManager` 一致；固定版本变化时更新对应构建参数。`run-docker.sh` 默认使用 Compose 层缓存，未变化的重启会跳过包安装层；只有明确需要干净重建时才设置 `DSH_BUILD_NO_CACHE=1`。

## 宿主要求

启动器要求：

- 已登录 Tailscale 的 Linux 宿主，且 `PATH` 上存在 Node.js、pnpm、Git、curl、`flock` 与 `readlink`；以及
- 容器运行时加 Compose —— Docker，或 podman 加 `docker-compose`/`podman-compose`；以及
- 一个带 lockfile 的仓库检出。停止现有组合前，若已安装的聚合包声明了该 sidebar 依赖，启动器会拒绝同时列出 `@linxin666/dsh-web-ui-all` 与 `dsh-better-sidebar` 的 `web` profile，并打印确切的 `dsh plugin remove` 命令。然后启动器在检出中运行 `pnpm install --frozen-lockfile` 与 `pnpm run build`，校验 web 前端 dist 和每个 client 包的 `lib/client.js`，最后才构建镜像。安装失败、编译失败或缺少产物时，服务会保持停止状态，而不会让进程读取部分替换的依赖项或产物。若所有权匹配的 `deepseek-harness.service` 正在运行，Docker 组合会在停止或重建前拒绝执行；必须先停止或卸载原生服务。

启动器使用第一个可达且具备可工作 Compose 提供方的容器引擎：带 Compose 插件的 Docker，其次是 `podman compose`，再次是 `podman-compose` 包装器；只有 `docker` 可执行文件但没有插件时，不会遮蔽可工作的 podman。在 SELinux 宿主（Fedora 默认开启）上，两个服务都设置 `label=disable`，使容器无需重打标签即可读写挂载的 home 与工具链。rootless podman 下，启动器生成的 override 追加 `userns_mode: keep-id`，把当前用户的 uid 一一映射进容器，agent 在挂载 home 中创建的文件在宿主上仍属于该用户。容器以 `DSH_HOST_USER_HOME` 属主的 uid/gid（`DSH_UID`/`DSH_GID`）运行，宿主用户不是 uid 1000 时也无需任何调整。

开发工具链是可选的。启动器从 `PATH` 发现 Flutter 与 Java，并按 `$ANDROID_HOME`、`$ANDROID_SDK_ROOT`、`~/Android/Sdk`、`~/android-sdk`、`/usr/lib/android-sdk`、`/opt/android-sdk` 的顺序发现 Android SDK。Compose 的 `PATH` 还会暴露已挂载 home 中的约定工具位置：Rust 使用 `~/.cargo/bin`，Go 使用 `~/.local/go-current/bin` 与 `~/go/bin`，Bun 使用 `~/.bun/bin`，Kotlin 使用 `~/.sdkman/candidates/kotlin/current/bin`，用户命令使用 `~/.local/bin`。宿主工具链不存在时不产生影响；明确设置但无效的 Flutter、Android 或 Java 覆盖变量会打印警告并被跳过。

如有需要，先允许当前用户管理 Tailscale Serve：

```sh
sudo tailscale set --operator="$USER"
```

### Fedora 说明

```sh
sudo dnf install podman docker-compose   # rootless podman + compose provider
systemctl --user enable --now podman.socket   # lets docker-compose talk to podman
loginctl enable-linger "$USER"           # keeps containers running after logout
```

rootless podman 在 `network_mode: host` 下共享宿主网络命名空间，两个回环服务与宿主 `tailscaled` 的交互与 Docker 下完全一致。无需安装 `podman-docker` 别名包；自动检测会识别其兼容 shim 并选择真实 podman 引擎，使 rootless `keep-id` 仍然生效。设置 `DSH_CONTAINER_RUNTIME=podman` 可明确该选择。

## 在宿主的 Tailscale 节点上运行

```sh
export DEEPSEEK_API_KEY=sk-...   # optional until a model request
./run-docker.sh
```

启动器安装并构建挂载的检出，从已发现的工具链推导 `DSH_HOST_FLUTTER_HOME`、`DSH_HOST_ANDROID_HOME` 与 `DSH_HOST_JAVA_HOME`（并打印一行摘要），从 `tailscale status` 读取宿主的 MagicDNS 名称、tailnet IPv4 与登录，构建镜像并启动两个回环服务。它从当前容器日志提取进程启动 URL，通过 Caddy 交换令牌，再使用所得浏览器 cookie 验证无关登录收到 HTTP 403、属主收到 HTTP 200。它在 Harness 浏览器信任栅栏中同时信任 MagicDNS 名称与 tailnet IPv4，仅在这些检查通过后发布 Tailscale HTTPS，并打印一次公开启动 URL。

可选的 `@linxin666/dsh-client-ui-task-board` 使用额外代理令牌保护控制路由。将其聚合行配置为接受启动器的受信 authority；启动器生成令牌并仅交给 Host 与 Caddy，Caddy 只在匹配 `TAILSCALE_OWNER` 后注入该令牌：

```yaml
- id: web-ui-task-board
  config:
    trustedProxyHosts: !!js (process.env.DSH_TRUSTED_HOSTS ?? '').split(/[,\s]+/).filter(Boolean)
```

宿主 home 以相同路径读写挂载到容器。启动器还写入一个每次启动生成的 Compose override 文件，以只读方式挂载 JDK，并挂载 Android SDK、仓库、udev 数据和 USB 总线——每一项都只在该宿主路径存在时挂载，因为 Compose 无法表达条件 bind mount，路径缺失时会让 daemon 在该路径创建空的 root 属主目录。已经位于已挂载宿主 home 之下的工具链无需额外挂载。工具链可用时，入口脚本把 `flutter`、`adb`、`dart` 和 `java` 链接到 `/usr/local/bin`，因为登录 shell 可能重置 `PATH`。

启动器选择本地 Docker 运行时时，默认把该引擎暴露给 agent，使部署脚本看到与宿主相同的能力。daemon socket 会授予等同于宿主 root 的权限；需要仅限容器的访问时可显式关闭：

```sh
DSH_ENABLE_HOST_DOCKER=0 ./run-docker.sh
```

启动器只接受本地 Unix Docker 端点，优先采用 `DOCKER_HOST`、其次采用活动 context；它把该 socket 挂载为 `/var/run/docker.sock`，并在降权到 `DSH_UID`／`DSH_GID` 时保留 socket 的数字组。非标准本地 socket 可通过 `DSH_HOST_DOCKER_SOCKET` 覆盖端点发现。socket 缺失、远程端点或组元数据无效都会在停止现有组合前失败。Podman 不向 agent 暴露 Docker socket；引擎确实位于远端时应改用 Remote SSH。

宿主 home 不是 `$HOME` 时设置 `DSH_HOST_USER_HOME`；需要覆盖 agent 工作目录时设置 `DSH_HOST_WORKSPACE`（默认 `$HOME/git`，缺失时带警告回退到 `$HOME`）；需要覆盖工具链发现结果时设置 `DSH_HOST_FLUTTER_HOME`、`DSH_HOST_ANDROID_HOME` 或 `DSH_HOST_JAVA_HOME`。

## 作为独立 tailnet 节点运行

容器需要持有独立 Tailscale 身份时，先设置 `TS_AUTHKEY`，再直接调用 Compose：

```sh
export DEEPSEEK_API_KEY=sk-...
export TS_AUTHKEY=tskey-auth-...
export TS_HOSTNAME=dsh
export DSH_HOST_USER_HOME="$HOME"
export DSH_HOST_FLUTTER_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v flutter)")")")"
export DSH_HOST_JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
docker compose -f docker/docker-compose.yml up -d --build
```

入口脚本启动镜像内置的 `tailscaled`，推导该节点的 MagicDNS 名称，把它加入受信任宿主，并从容器持有的 tailnet 节点提供 HTTPS。`tsstate` volume 保留节点身份。此模式下 Caddy 服务仍是回环端点，但不是对外服务路径。

直接调用 Compose 会跳过启动器生成的 override 文件，因此只挂载宿主 home：`$HOME` 之外的工具链（JDK、Android SDK、udev、USB）在容器内不可用，除非自行补充挂载或运行 `./run-docker.sh`。

## 环境变量参考

| 变量                    | 默认值              | 含义                                          |
| ----------------------- | ------------------- | --------------------------------------------- |
| `DEEPSEEK_API_KEY`      | _（未设置）_        | 模型凭据；没有它也能启动 GUI                  |
| `DEEPSEEK_BASE_URL`     | _（未设置）_        | 可选的 DeepSeek 兼容端点                      |
| `DSH_PUBLIC_PORT`       | `4080`              | Caddy 与 Tailscale Serve 使用的宿主回环端口   |
| `DSH_BACKEND_PORT`      | `4081`              | `dsh web` 使用的宿主回环端口；必须与公开端口不同 |
| `DSH_CONTAINER_RUNTIME` | `auto`              | `auto`、`docker` 或 `podman`；选中的引擎必须可达 |
| `DSH_ENABLE_HOST_DOCKER` | Docker 下为 `1`；podman 下为 `0` | 设为 `0` 时不向 agent 提供选中的本地 Docker 引擎 |
| `DSH_HOST_DOCKER_SOCKET` | `DOCKER_HOST` 或活动 context 的 socket | 仅在启用宿主 Docker 控制时使用的绝对本地 socket 覆盖值 |
| `DSH_BUILD_NO_CACHE`    | `0`                 | 设为 `1` 时明确执行干净镜像重建              |
| `DSH_STARTUP_TIMEOUT`   | `90`                | 等待健康检查门控 auth proxy 的秒数            |
| `DSH_HOST_USER_HOME`    | 启动器中为 `$HOME`  | 以相同容器路径读写挂载的宿主 home             |
| `DSH_UID` / `DSH_GID`   | 宿主 home 的属主    | harness 进程在容器内的 uid/gid（启动器设置） |
| `DSH_HOST_WORKSPACE`    | `$HOME/git`，缺失时 `$HOME` | 容器内 agent 的工作目录             |
| `DSH_HOST_FLUTTER_HOME` | 从 `PATH` 上的 `flutter` 推导 | Flutter SDK 路径；缺失时为空，容器内没有 Flutter |
| `DSH_HOST_ANDROID_HOME` | 自动发现（见宿主要求） | Android SDK 路径；缺失时为空，容器内没有 `adb` |
| `DSH_HOST_JAVA_HOME`    | 从 `PATH` 上的 `java` 推导 | 宿主 JDK 路径；缺失时为空，容器内没有 Java    |
| `DSH_TRUSTED_HOSTS`     | _（未设置）_        | 追加到宿主 MagicDNS 名称与 tailnet IPv4 的其他 API authority（二者由启动器预填） |
| `DSH_TASK_BOARD_PROXY_TOKEN` | 启动器每次运行时随机生成 | task-board Host 路由与属主认证 Caddy 代理共享的内部凭据 |
| `TAILSCALE_OWNER`       | 宿主 Tailscale 登录 | 可通过 Caddy 使用仅限属主 RPC 路径的登录      |
| `TS_AUTHKEY`            | _（未设置）_        | 启用容器自有节点模式的 auth key               |
| `TS_HOSTNAME`           | Compose 中为 `dsh`  | 容器持有的 Tailscale 节点名称                 |
| `TS_EXTRA_ARGS`         | _（未设置）_        | 额外的 `tailscale up` 参数                    |
| `TS_USERSPACE`          | `1`                 | 容器自有节点使用 userspace networking         |

## 让 fork 与上游保持同步

```sh
./upstream-merge.sh
```

脚本把 `upstream/master` 合并进 `master`，将镜像的 `DSH_VERSION` 重新固定到合并后的版本，lockfile 变化时重装依赖，并运行类型检查。发生冲突时，它保留进行中的合并并列出冲突文件（双语文档对用 `pnpm run resolve-translation-pairing-conflicts` 解决）；手工解决并提交后重新运行即可。脚本不会推送——审查后自行 `git push`。

Docker 工具位于产品包之外，因此上游合并通常只有很小的冲突面。

## 限制

- 镜像运行 `DSH_VERSION` 对应的已发布包，而不是当前 monorepo 源码。
- 新增仅限属主的 API 方法或 namespace 必须同时加入两个 Caddy 敏感路径 matcher；遗漏时，tailnet ACL 允许的任何浏览器会话都能使用它。
- 宿主模式有意针对单台机器配置，并授予容器对宿主 home 的读写访问。启动器选择 Docker 且未显式关闭时，agent 可通过 daemon 挂载或修改任意宿主路径，因此拥有等同于宿主 root 的权限。仅允许你信任其使用已启用权限的 tailnet 身份访问 GUI。

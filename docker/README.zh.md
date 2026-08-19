# 通过 Tailscale 提供服务的 Docker 版 DeepSeek Harness

[English](README.md) | 中文

这个个人 fork 工具在容器中运行已发布的 DeepSeek Harness Web GUI（`dsh web`），并让它访问宿主的仓库；宿主上已安装时，还可访问 Flutter、Android、Java 和 USB 设备。

## 为什么使用回环地址与 Tailscale

`dsh web` 绑定 `127.0.0.1`，因为它的 API 可以执行工具和 shell 命令。Docker 组合保留这项限制，不发布容器端口，也不把应用绑定到网络接口。

宿主模式包含三跳：宿主 Tailscale Serve 终止 tailnet HTTPS，只有回环地址可访问的 Caddy 代理授权来自一个 Tailscale 登录的配置请求，容器化 Harness 则监听另一个回环端口。Tailscale Serve 会剥除客户端提供的身份头，并提供已认证的 `Tailscale-User-Login`；Caddy 仅针对已配置属主与特权 RPC 路径，把 `Host` 和 `Origin` 改写为回环地址。其他请求保留 tailnet authority，并继续经过 Harness 浏览器信任检查。

Harness 的 `--trusted-host` 选项是 DNS rebinding 与跨站栅栏，而不是认证机制。tailnet ACL 控制 GUI 访问。Caddy 规则把设置、凭据、模型发现、preset 管理和原生宿主操作限制给 `TAILSCALE_OWNER`，但所有获准访问 GUI 的 tailnet 用户都能通过普通 agent 工具操作已挂载的宿主文件。

## 文件

| 路径                 | 用途                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `../Dockerfile`      | 包含已发布 `@deepseek-ai/dsh` CLI 的运行时镜像                          |
| `dsh-entrypoint.sh`  | 启动 `dsh web`、暴露已挂载工具链，并可选择加入由容器持有的 tailnet 节点 |
| `docker-compose.yml` | 宿主网络组合、宿主开发环境挂载、USB 访问和代理                          |
| `Caddyfile`          | 为仅限属主的配置 RPC 提供回环身份代理                                   |
| `../run-docker.sh`   | 发现宿主工具链、构建、启动、检查并发布组合                                 |
| `../.dockerignore`   | 排除不需要的构建上下文文件                                              |
| `browser-e2e/`       | Web 浏览器 e2e 车道（`pnpm run test:web`）的可重现 Chromium 运行时      |
| `browser-e2e/run.sh` | 构建该运行时并针对当前检出运行车道                                      |

## 构建

```sh
docker build -t dsh-tailscale:local -f Dockerfile .
```

镜像从 npm 安装已发布的 `@deepseek-ai/dsh` 包、其运行时对等包，以及用于 profile 插件管理的 pnpm。`DSH_VERSION` 默认为 `0.1.0-rc.7`，`PNPM_VERSION` 则与仓库的 `packageManager` 一致；固定版本变化时更新对应构建参数。

## 宿主要求

启动器要求：

- 宿主已登录 Tailscale；以及
- `PATH` 上存在 Docker、Node.js 和 curl。

开发工具链是可选的。启动器从 `PATH` 发现 Flutter 与 Java，并按 `$ANDROID_HOME`、`$ANDROID_SDK_ROOT`、`~/Android/Sdk`、`~/android-sdk`、`/usr/lib/android-sdk`、`/opt/android-sdk` 的顺序发现 Android SDK。缺失的工具链只产生警告并以无该工具链的方式启动：容器内随后没有 `flutter`、`adb` 或 `java`，也没有对应挂载。覆盖变量（`DSH_HOST_FLUTTER_HOME`、`DSH_HOST_ANDROID_HOME`、`DSH_HOST_JAVA_HOME`）指向的路径缺少预期可执行文件时，同样被跳过。

如有需要，先允许当前用户管理 Tailscale Serve：

```sh
sudo tailscale set --operator="$USER"
```

## 在宿主的 Tailscale 节点上运行

```sh
export DEEPSEEK_API_KEY=sk-...   # optional until a model request
./run-docker.sh
```

启动器从已发现的工具链推导 `DSH_HOST_FLUTTER_HOME`、`DSH_HOST_ANDROID_HOME` 与 `DSH_HOST_JAVA_HOME`（并打印一行摘要），从 `tailscale status` 读取宿主的 MagicDNS 名称、tailnet IPv4 与登录，构建镜像，启动两个回环服务，并验证无关登录收到 HTTP 403、属主收到 HTTP 200。它在 harness 浏览器信任栅栏中同时信任 MagicDNS 名称与 tailnet IPv4，只有这些检查通过后，它才会发布 `https://<host>.<tailnet>.ts.net/`。

宿主 home 以相同路径读写挂载到容器。启动器还写入一个每次启动生成的 Compose override 文件，以只读方式挂载 JDK，并挂载 Android SDK、仓库、udev 数据和 USB 总线——每一项都只在该宿主路径存在时挂载，因为 Compose 无法表达条件 bind mount，路径缺失时会让 daemon 在该路径创建空的 root 属主目录。已经位于已挂载宿主 home 之下的工具链无需额外挂载。工具链可用时，入口脚本把 `flutter`、`adb`、`dart` 和 `java` 链接到 `/usr/local/bin`，因为登录 shell 可能重置 `PATH`。

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
| `DSH_BACKEND_PORT`      | `4081`              | `dsh web` 使用的宿主回环端口                  |
| `DSH_HOST_USER_HOME`    | 启动器中为 `$HOME`  | 以相同容器路径读写挂载的宿主 home             |
| `DSH_HOST_WORKSPACE`    | `$HOME/git`，缺失时 `$HOME` | 容器内 agent 的工作目录             |
| `DSH_HOST_FLUTTER_HOME` | 从 `PATH` 上的 `flutter` 推导 | Flutter SDK 路径；缺失时为空，容器内没有 Flutter |
| `DSH_HOST_ANDROID_HOME` | 自动发现（见宿主要求） | Android SDK 路径；缺失时为空，容器内没有 `adb` |
| `DSH_HOST_JAVA_HOME`    | 从 `PATH` 上的 `java` 推导 | 宿主 JDK 路径；缺失时为空，容器内没有 Java    |
| `DSH_TRUSTED_HOSTS`     | _（未设置）_        | 追加到宿主 MagicDNS 名称与 tailnet IPv4 的其他 API authority（二者由启动器预填） |
| `TAILSCALE_OWNER`       | 宿主 Tailscale 登录 | 可通过 Caddy 使用仅限属主 RPC 路径的登录      |
| `TS_AUTHKEY`            | _（未设置）_        | 启用容器自有节点模式的 auth key               |
| `TS_HOSTNAME`           | Compose 中为 `dsh`  | 容器持有的 Tailscale 节点名称                 |
| `TS_EXTRA_ARGS`         | _（未设置）_        | 额外的 `tailscale up` 参数                    |
| `TS_USERSPACE`          | `1`                 | 容器自有节点使用 userspace networking         |

## 让 fork 与上游保持同步

```sh
git fetch upstream
git merge upstream/master
git push origin master
```

Docker 工具位于产品包之外，因此上游合并通常只有很小的冲突面。

## 限制

- 镜像运行 `DSH_VERSION` 对应的已发布包，而不是当前 monorepo 源码。
- 新增仅限回环访问的 RPC 必须加入 Caddy 属主 matcher 才能远程配置；遗漏时会以 HTTP 403 快速失败。
- 宿主模式有意针对单台机器配置，并授予容器对宿主 home 的读写访问。只允许你信任的 tailnet 身份访问 GUI，因为这些身份能对该数据执行 shell 命令。

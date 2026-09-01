# DeepSeek Harness 原生服务

[English](README.md) | 中文

`start.sh` 将当前检出安装为系统级 `deepseek-harness.service`。Harness 与 Caddy 以执行安装的非 root 用户运行。Tailscale 模式通过 Tailscale Serve 发布回环身份代理；NetBird 模式直接将 Caddy 绑定到宿主的 NetBird 地址，供 mesh 访问。

## 前置要求

宿主必须使用 systemd，并已连接宿主 Tailscale 或 NetBird 节点。服务用户的非交互式登录 shell 必须提供 Caddy 2、Node.js `^22.19.0 || >=24.0.0`、Git、所选 VPN CLI、`setsid` 与 `ss`，并提供 Corepack 或 pnpm `11.7.0`；宿主还需要 `sudo`、`systemctl`、`systemd-analyze`、`runuser`、`getent`、`install`、`flock` 和 `readlink`。在 Ubuntu 与 Fedora 上，安装过程会先从已配置的 APT 或 DNF 仓库安装缺失的 Caddy 包，再校验版本。pnpm 缺失时，启动器会通过 Corepack 激活固定版本。其他依赖仍由用户的登录 shell 管理。

如果已配置的软件仓库不提供相应软件包，请配置官方 [Caddy](https://caddyserver.com/docs/install)、[Tailscale](https://tailscale.com/kb/installation) 或 [NetBird](https://docs.netbird.io/get-started/install/linux) 仓库。等效的手动命令如下：

```sh
# Ubuntu
sudo apt install caddy tailscale iproute2 git curl util-linux coreutils
# NetBird alternative
sudo apt install caddy netbird iproute2 git curl util-linux coreutils

# Fedora
sudo dnf install caddy tailscale iproute git curl util-linux coreutils
# NetBird alternative
sudo dnf install caddy netbird iproute git curl util-linux coreutils

# Arch
sudo pacman -S caddy tailscale iproute2 git curl util-linux coreutils
# NetBird alternative
sudo pacman -S caddy netbird iproute2 git curl util-linux coreutils
```

安装包含 Corepack 的受支持 Node.js 版本。启动器会自动激活 pnpm `11.7.0`；不含 Corepack 的 Node.js 发行版需要另行安装 pnpm `11.7.0`。

## 安装或更新

以将要拥有 Harness 进程的非 root 用户运行启动器：

```sh
./start.sh

# Use NetBird instead of Tailscale
DSH_VPN_PROVIDER=netbird ./start.sh
```

启动器仅为缺失的 Caddy 包安装、确切的自有 Docker 接管、systemd、root 属主配置与所选 VPN 设置使用 `sudo`。它会为每个安装阶段显示实时旋转进度与耗时，同时隐藏成功的包管理器、构建与 unit 校验细节；执行 `DSH_VERBOSE=1 ./start.sh` 可在诊断时流式显示这些命令。它通过用户登录 shell 在原检出中完成准备，保留该用户的补充组，在切换前构建，并等待 systemd `Type=notify` 就绪结果。监听器检查接受任意 HTTP 响应，因为受令牌保护的根路径会拒绝未认证请求。监督进程会在其私有运行时目录中捕获后端启动 URL，并且只把其中的令牌交给 Caddy。当根路径请求没有 Harness cookie 时，Caddy 使用 Serve 注入的 `TAILSCALE_OWNER` 身份交换该令牌，以取得绑定 authority 的浏览器 cookie；身份代理还必须拒绝非属主登录并允许属主，然后 systemd 才报告就绪。安装过程会把解析到的 Node.js 与 pnpm 路径写入 unit，因此重启不依赖 systemd 的默认 PATH。root 属主的启动器、代理配置与校验辅助程序位于 `/usr/local/libexec/deepseek-harness`；服务仍以非 root 用户直接运行检出。生成的后端启动器保持不可执行并由 Bash 读取运行，因此支持使用 `noexec` 挂载的 systemd 运行时目录。就绪后，`start.sh` 与 `status` 都打印干净的公开 URL，已启用的服务则继续在后台运行；浏览器不再需要进程启动令牌。没有缓存 sudo 授权的非交互调用方会在更改 Docker、systemd 或 Serve 状态之前失败，并得到需要交互运行的确切命令。更新时会先停止已有且所有权匹配的原生服务，再替换检出产物；构建失败则重新启动已安装服务。

当该检出的确切 Docker 部署正在运行时，`start.sh` 会在完成原生构建与所有权检查后调用本地 Docker CLI，移除其 `dsh` 与 `auth-proxy` 容器再启动原生服务；命名 volume 会保留。它不会构建或启动 Docker，纯原生宿主无需 Docker，并会保留其他检出的容器。其他监听器、VPN operator 与 Serve 路由都会导致失败，不会被替换。接管是单向的：如果原生服务随后未能就绪，请修正报告的错误后重新运行 `start.sh`；已移除的容器不会重建。

服务直接获得该用户的宿主权限与登录 shell 工具，而不是一组经过筛选的容器挂载。`docker` 组成员身份让 agent 可通过 Docker daemon 获得等同于宿主 root 的权限；请相应限制 VPN 访问。

## 运维

```sh
./start.sh start
./start.sh stop
./start.sh restart
./start.sh status
./start.sh logs
./start.sh uninstall
```

`status` 打印 systemd 状态和原生 URL，`logs` 跟随系统 journal。`uninstall` 只移除所有权匹配的 unit 与 Serve 路由，并保留 `/etc/deepseek-harness.env` 和 `/var/lib/deepseek-harness/deployment.json`。start、stop、restart 与 uninstall 在已安装 unit 或实时路由不匹配 root 属主部署状态时都会拒绝执行。

## 配置

安装过程只创建一次 `/etc/deepseek-harness.env`，更新与卸载都会保留该文件。它必须保持为 root 属主、非符号链接的普通文件，并且组与其他用户都不可写。

| 设置                      | 默认值                 | 含义                            |
| ------------------------- | ---------------------- | ------------------------------- |
| `DSH_VPN_PROVIDER`        | `tailscale`            | VPN 传输：`tailscale` 或 `netbird` |
| `DSH_BACKEND_PORT`        | `4081`                 | `dsh web` 的回环端口            |
| `DSH_PUBLIC_PORT`         | `4080`                 | Caddy 与 Serve 目标的回环端口   |
| `DSH_HTTPS_PORT`          | `443`                  | 宿主 Tailscale Serve HTTPS 端口 |
| `DSH_STARTUP_TIMEOUT`     | `90`                   | 就绪超时秒数                    |
| `TAILSCALE_OWNER`         | 首次安装时的已连接登录 | 可使用仅限属主代理路由的登录    |
| `DSH_EXTRA_TRUSTED_HOSTS` | 空                     | 逗号分隔的其他 Harness 受信宿主 |

使用 root 权限编辑文件，并保证每个必需键恰好出现一次。Tailscale 模式才要求 `TAILSCALE_OWNER`。端口变更应运行 `./start.sh`，使部署状态与 Serve 所有权一同推进；其他变更运行 `./start.sh restart`。需要不同的端口必须互不相同，且端口取值为 1 至 65535；启动超时必须为 1 至 3600 秒。配置的属主必须匹配已连接的宿主节点登录。

## NetBird 访问

安装时设置 `DSH_VPN_PROVIDER=netbird`，或编辑 root 属主的配置文件后重新运行 `./start.sh install`。宿主必须已通过 `netbird up` 连接；启动器不会加入网络，也不会保存 setup key。Caddy 会绑定宿主的 NetBird IPv4 地址，并打印 `http://<netbird-ip>:4080/` URL。NetBird ACL 策略控制哪些 peer 可以访问，Harness 启动令牌再交换为普通浏览器 cookie。NetBird 没有 Tailscale 注入的用户登录标识的本地等价物，因此直接 mesh 模式不会在代理层声称逐用户身份。

## Tailscale 授权

Harness 与 Caddy 仅绑定 `127.0.0.1`。宿主 Tailscale Serve 终止 HTTPS 并提供已认证的 `Tailscale-User-Login`；[`Caddyfile`](Caddyfile) 仅为 `TAILSCALE_OWNER` 转发完整的 `/api/*` 命名空间，并对其他身份返回 403。该命名空间规则覆盖设置、会话、所有已安装工具与插件 API、Remote SSH 以及 task-board 控制，不依赖可能过时的路由白名单。tailnet ACL 仍决定谁能访问静态 GUI，但只有配置的属主可以凭服务用户权限使用 Host API。

仅当 Tailscale operator 为空时，安装过程才会把它设为服务用户；存在其他 operator 时会拒绝执行。发布与清理会在修改 Serve 状态前比较 HTTPS 端口与回环目标。此模式始终使用宿主 Tailscale 节点，不接受 `TS_AUTHKEY`。

## 限制

- 托管服务要求 Linux、systemd 与已连接的宿主 Tailscale 或 NetBird 节点；依赖指引覆盖 Ubuntu、Fedora 和 Arch。在 SELinux 宿主上，安装过程会恢复 `/usr/local/libexec` 下 root 属主控制文件的标签，而不会让 systemd 执行 home 目录中的启动器。
- 启动器直接执行当前检出，不安装已发布包，也不会把源码复制到私有服务目录。
- 原生与 Docker 启动器不能同时拥有相同端口或 Serve 路由。只有在停止或卸载原生服务后才能使用 [`run-docker.sh`](../run-docker.sh)。
- Ubuntu 与 Fedora 安装过程可能在为事务遮蔽 Caddy 包服务后安装缺失的 Caddy 包，但不会配置第三方仓库，也不会安装或升级其他宿主软件包；Arch 会改为报告手动命令。
- 卸载会保留配置与部署状态，以供检查或后续重新安装。

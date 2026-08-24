# DeepSeek Harness 原生服务

[English](README.md) | 中文

`start.sh` 将当前检出安装为系统级 `deepseek-harness.service`。Harness 与 Caddy 以执行安装的非 root 用户运行，宿主 Tailscale Serve 则发布回环身份代理。

## 前置要求

宿主必须使用 systemd，并已连接宿主 Tailscale 节点。服务用户的非交互式登录 shell 必须提供 Caddy 2、Node.js `^22.19.0 || >=24.0.0`、pnpm `11.7.0`、Git、curl、Tailscale、`setsid` 与 `ss`；宿主还需要 `sudo`、`systemctl`、`systemd-analyze`、`runuser`、`getent`、`install`、`flock` 和 `readlink`。在 Ubuntu 与 Fedora 上，安装过程会先从已配置的 APT 或 DNF 仓库安装缺失的 Caddy 包，再校验版本。包括 Node.js 与 pnpm 在内的其他依赖仍由用户的登录 shell 管理。

如果已配置的软件仓库不提供相应软件包，请配置官方 [Caddy](https://caddyserver.com/docs/install) 与 [Tailscale](https://tailscale.com/kb/installation) 仓库。等效的手动命令如下：

```sh
# Ubuntu
sudo apt install caddy tailscale iproute2 git curl util-linux coreutils

# Fedora
sudo dnf install caddy tailscale iproute git curl util-linux coreutils

# Arch
sudo pacman -S caddy tailscale iproute2 git curl util-linux coreutils
```

安装受支持的 Node.js 版本，再单独固定 pnpm：

```sh
corepack enable
corepack prepare pnpm@11.7.0 --activate
```

## 安装或更新

以将要拥有 Harness 进程的非 root 用户运行启动器：

```sh
./start.sh
```

启动器仅为缺失的 Caddy 包安装、确切的自有 Docker 接管、systemd、root 属主配置与 Tailscale 设置使用 `sudo`。它会为每个安装阶段显示实时旋转进度与耗时，同时隐藏成功的包管理器、构建与 unit 校验细节；执行 `DSH_VERBOSE=1 ./start.sh` 可在诊断时流式显示这些命令。它通过用户登录 shell 在原检出中完成准备，保留该用户的补充组，在切换前构建，并等待 systemd `Type=notify` 就绪结果。安装过程会把解析到的 Node.js 与 pnpm 路径写入 unit，因此重启不依赖 systemd 的默认 PATH。root 属主的启动器、代理配置与校验辅助程序位于 `/usr/local/libexec/deepseek-harness`；服务仍以非 root 用户直接运行检出。生成的后端启动器保持不可执行并由 Bash 读取运行，因此支持使用 `noexec` 挂载的 systemd 运行时目录。就绪后，`start.sh` 打印 URL 并返回调用 shell，已启用的服务则继续在后台运行。没有缓存 sudo 授权的非交互调用方会在更改 Docker、systemd 或 Serve 状态之前失败，并得到需要交互运行的确切命令。更新时会先停止已有且所有权匹配的原生服务，再替换检出产物；构建失败则重新启动已安装服务。

当该检出的确切 Docker 部署正在运行时，`start.sh` 会在完成原生构建与所有权检查后调用本地 Docker CLI，移除其 `dsh` 与 `auth-proxy` 容器再启动原生服务；命名 volume 会保留。它不会构建或启动 Docker，纯原生宿主无需 Docker，并会保留其他检出的容器。其他监听器、Tailscale operator 与 Serve 路由都会导致失败，不会被替换。接管是单向的：如果原生服务随后未能就绪，请修正报告的错误后重新运行 `start.sh`；已移除的容器不会重建。

服务直接获得该用户的宿主权限与登录 shell 工具，而不是一组经过筛选的容器挂载。`docker` 组成员身份让 agent 可通过 Docker daemon 获得等同于宿主 root 的权限；请相应限制 tailnet 访问。

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
| `DSH_BACKEND_PORT`        | `4081`                 | `dsh web` 的回环端口            |
| `DSH_PUBLIC_PORT`         | `4080`                 | Caddy 与 Serve 目标的回环端口   |
| `DSH_HTTPS_PORT`          | `443`                  | 宿主 Tailscale Serve HTTPS 端口 |
| `DSH_STARTUP_TIMEOUT`     | `90`                   | 就绪超时秒数                    |
| `TAILSCALE_OWNER`         | 首次安装时的已连接登录 | 可使用仅限属主代理路由的登录    |
| `DSH_EXTRA_TRUSTED_HOSTS` | 空                     | 逗号分隔的其他 Harness 受信宿主 |

使用 root 权限编辑文件，并保证每个键恰好出现一次。端口变更应运行 `./start.sh`，使部署状态与 Serve 所有权一同推进；其他变更运行 `./start.sh restart`。需要不同的端口必须互不相同，且端口取值为 1 至 65535；启动超时必须为 1 至 3600 秒。配置的属主必须匹配已连接的宿主节点登录。

## Tailscale 授权

Harness 与 Caddy 仅绑定 `127.0.0.1`。宿主 Tailscale Serve 终止 HTTPS 并提供已认证的 `Tailscale-User-Login`；[`Caddyfile`](Caddyfile) 将设置、凭据、模型发现、preset 管理、原生宿主操作、Remote SSH 与 task-board 控制路由限制给 `TAILSCALE_OWNER`。tailnet ACL 仍决定谁能访问 GUI，而每个获准进入 GUI 的用户都能以服务用户的宿主权限运行普通 agent 工具。

仅当 Tailscale operator 为空时，安装过程才会把它设为服务用户；存在其他 operator 时会拒绝执行。发布与清理会在修改 Serve 状态前比较 HTTPS 端口与回环目标。此模式始终使用宿主 Tailscale 节点，不接受 `TS_AUTHKEY`。

## 限制

- 托管服务要求 Linux、systemd 与宿主 Tailscale 节点；依赖指引覆盖 Ubuntu、Fedora 和 Arch。在 SELinux 宿主上，安装过程会恢复 `/usr/local/libexec` 下 root 属主控制文件的标签，而不会让 systemd 执行 home 目录中的启动器。
- 启动器直接执行当前检出，不安装已发布包，也不会把源码复制到私有服务目录。
- 原生与 Docker 启动器不能同时拥有相同端口或 Serve 路由。只有在停止或卸载原生服务后才能使用 [`run-docker.sh`](../run-docker.sh)。
- Ubuntu 与 Fedora 安装过程可能在为事务遮蔽 Caddy 包服务后安装缺失的 Caddy 包，但不会配置第三方仓库，也不会安装或升级其他依赖；Arch 会改为报告手动命令。
- 卸载会保留配置与部署状态，以供检查或后续重新安装。

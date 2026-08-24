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

启动器仅为缺失的 Caddy 包安装、systemd、root 属主配置与 Tailscale 设置使用 `sudo`。它打印每个安装阶段，通过用户登录 shell 在原检出中完成准备，保留该用户的补充组，在切换前构建，并等待 systemd `Type=notify` 就绪结果。root 属主的启动器、代理配置与校验辅助程序位于 `/usr/local/libexec/deepseek-harness`；服务仍以非 root 用户直接运行检出。就绪后，`start.sh` 打印 URL 并返回调用 shell，已启用的服务则继续在后台运行。没有缓存 sudo 授权的非交互调用方会在更改 Docker、systemd 或 Serve 状态之前失败，并得到需要交互运行的确切命令。更新时会先停止已有且所有权匹配的原生服务，再替换检出产物；构建失败则重新启动已安装服务。

如果该检出对应的确切 Docker 部署正在运行，安装过程会先验证两个 Compose 服务标签、规范化工作目录、Compose 配置标签和当前 Serve 目标，再停止其 `dsh` 与 `auth-proxy` 容器 ID。原生服务就绪后会删除已停止容器，但保留命名 volume；就绪失败时会重新启动相同 ID，并验证恢复后的回环代理。标签含糊、无关监听器、其他 Tailscale operator 或不同 Serve 目标都会导致快速失败，不会被替换。

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

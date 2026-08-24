# Agent Note: Docker 启动器对缺失的宿主工具链降级而不是失败

Status: implemented

[English](2026-08-19-docker-launcher-degrades-missing-toolchains.md) | 中文

## 问题

`run-docker.sh` 硬性要求三种机器特定的宿主布局：Android platform tools 必须位于 `/usr/lib/android-sdk`、`PATH` 上必须有 `flutter` 与 `java` 可执行文件、仓库必须位于 `$HOME/git`。没有发行版 Android SDK 包的宿主——例如把 SDK 放在 `~/Android/Sdk` 或完全没有 Android 工具链的机器——在启动时以 `error: Android SDK not found under /usr/lib/android-sdk` 中止，尽管 `adb` 对提供 GUI 服务和编辑非 Android 仓库是可选的。同样的脆弱性还体现在更深一层：脚本只以 `/usr/bin/docker` 调用 Docker（在 Docker 位于其他路径的宿主上失败，例如 `/usr/local/bin/docker`），而 `docker-compose.yml` 把 `/usr/lib/android-sdk`、`$HOME/git` 和 sdkman 的 JDK 路径硬编码进环境与 bind mount，因此在布局不同的宿主上执行 Compose `up` 要么失败，要么挂载不存在的路径（让 Docker daemon 在该路径创建空的 root 属主目录）。

这些工具链是为已挂载 agent 提供的便利，不是提供 harness GUI 服务的先决条件；把它们当作先决条件使启动器只能运行在一台机器上，而不是与系统无关。

## 决策

`run-docker.sh` 区分硬性先决条件与可选工具链。硬性先决条件——一个容器运行时（Docker，或带 compose 提供方的 podman；见 2026-08-20 移植性笔记）、`PATH` 上的 `node`、`curl`、`tailscale`，存在的宿主 home，存在的仓库，以及已安装并已构建的检出（见 2026-08-20 检出预检笔记）——仍然以 `error:` 消息中止。其余一切以 `warning:` 消息降级，并输出一行 `host toolchains:` 摘要：

- 存在时从 `PATH` 推导 Flutter 与 Java；缺失或显式覆盖无效时把变量置空。
- Android SDK 按 `$ANDROID_HOME`、`$ANDROID_SDK_ROOT`、`~/Android/Sdk`、`~/android-sdk`、`/usr/lib/android-sdk`、`/opt/android-sdk` 的顺序发现——第一个具有 `platform-tools/adb` 的候选者胜出。`DSH_HOST_ANDROID_HOME` 指向的路径缺少 `platform-tools/adb` 时警告并继续，不带 SDK 启动。
- `$HOME/git` 缺失时回退到以 `$HOME` 作为工作区。
- Docker 通过 `command -v docker` 解析，而不是硬编码路径（后续笔记将其泛化为 docker 或 podman 运行时检测）。

置空的工具链变量以空值传入 Compose：基础 `docker-compose.yml` 从启动器的发现结果插值 `ANDROID_HOME`、`ANDROID_SDK_ROOT`、`JAVA_HOME`、`FLUTTER_ROOT`、`DSH_WORKSPACE` 与 `PATH`（嵌套的 `${VAR:-…}` 默认值覆盖缺失情形），而 `dsh-entrypoint.sh` 本来就用 `-x` 守卫每个符号链接，因此缺失的工具链只是在容器内不产生 `flutter`/`adb`/`java`。

可选 bind mount 移出基础 compose 文件，改为由脚本在 `mktemp -d` 目录（退出时删除）中生成的每次启动 override 文件：JDK 只读，加上 Android SDK、home 之外的 Flutter、home 之外的仓库、`/run/udev` 与 `/dev/bus/usb`，每一项都只在该宿主路径存在时挂载。Compose 无法表达条件 bind mount，而挂载缺失路径会让 daemon 创建空的 root 属主目录，所以"存在才挂载"必须是一个生成的文件。基础文件只保留每台宿主都提供的两个挂载：home 目录与 `tsstate` volume。直接 `docker compose up`（自有节点模式）因此只挂载 home——README 记录了这一点。

宿主 Docker 控制与工具链发现分开处理，因为其 socket 会授予等同于宿主 root 的权限。选择 Docker 时默认把本地 Unix 端点暴露给 agent；`DSH_ENABLE_HOST_DOCKER=0` 可选择关闭。生成的 override 添加该 socket 与 `DOCKER_HOST`，并把 socket 的数字 gid 作为 Harness 进程唯一的 supplementary group 传给入口脚本。镜像包含 Docker 客户端和维护中的 CLI 插件，但不包含 daemon。关闭时不添加 socket 或组；路径无效和远程端点都会在停止运行中的组合前失败，而 podman 在其独立 socket 模型下保持不暴露。

## 备选方案

**保留硬性要求并文档化受支持的布局。** 否决：harness GUI 不需要 `adb` 就能服务，而启动器存在的意义是在用户实际拥有的机器上运行容器，不是在一台精心配置的发行版上。

**缺失 SDK 时警告，但布局不同仍失败。** 否决：`$HOME/git` 只是一位主要用户的约定；任何存在的目录都能作为 agent 工作区，失败毫无收益。

**用 Compose profile 或 `${VAR:?}` 守卫表达可选挂载。** 否决：profile 选择的是服务而不是单个 bind mount，任何插值特性都无法条件性地产生 volume 条目；生成的 override 文件是 Compose 自身提供的唯一机制。

**要求显式启用选中的本地 Docker socket。** 否决：启动器本身已依赖该引擎，而向 agent 隐藏它会让部署审计错误地报告宿主缺少 Docker，并转向不必要的安装或远程 builder。启动器会打印等同于宿主 root 的权限，并保留显式关闭选项。

**宿主没有 SDK 时回退为在镜像内安装。** 否决：这会与容器本应共享的宿主工具链（针对宿主 `adb` 的设备构建、只读宿主 JDK）悄然分叉，使镜像膨胀，并在构建时需要网络。

## 后果

启动器现在可以在只有任意工具链子集的宿主上启动：只有 Flutter 与 Java 的机器（报告中的情形）带一条警告启动且没有 Android 挂载，没有任何工具链或 `~/git` 的裸服务器也能提供 GUI。在原来那台全配置机器上行为不变——相同的环境值、相同的挂载（包括 `/usr/lib/android-sdk` 与只读 JDK）——由 stub 宿主套件（覆盖 home 内 SDK、仅发行版路径、环境变量 `ANDROID_HOME`、有效与无效显式覆盖、裸宿主等八种宿主场景，加一次真实工具链冒烟运行；该套件后来扩展到 podman 运行时检测与 uid/gid 映射，见 2026-08-20 移植性笔记）以及用真实 Compose v5.5.0 二进制执行的 `docker compose config` 验证，确认了嵌套默认值插值与基础+override 的 volume 并集且保留 `:ro`。

启用宿主 Docker 后，部署脚本使用与宿主预期相同的 `docker` CLI，而 daemon 仍由宿主持有。这项显式启用的权限有意强于文件工具 sandbox：daemon 操作可以挂载任意宿主路径并绕过容器文件系统限制，因此只能交给受信任的 GUI 身份。

代价：期望容器内有 `adb` 的用户必须阅读 `host toolchains:` 行才能注意到缺失（警告列出了每个检查过的位置）；自有节点 Compose 调用不再自动获得工具链挂载——必须自行补充或使用 `run-docker.sh`。工具链发现仍是 shell 启发式：SDK 位于候选列表之外的宿主必须显式设置 `DSH_HOST_ANDROID_HOME`，而无效的显式覆盖被跳过并警告而不是失败，因为它命名的是一个便利条件，不是先决条件。

仓库内的启动器套件针对 stub 宿主命令与真实 Unix socket 运行 `run-docker.sh` 和 `dsh-entrypoint.sh`。它固定检出预检顺序、生成的 Docker 挂载和环境，以及 supplementary group 保留；Dockerfile 断言固定该路径使用的客户端产物。

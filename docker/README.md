# DeepSeek Harness in Docker, served over Tailscale

English | [中文](README.zh.md)

This personal-fork utility runs the published DeepSeek Harness Web GUI (`dsh web`) in a container with the host's repositories and, when installed on the host, Flutter, Android, Java, and USB device access.

## Why loopback + Tailscale

`dsh web` binds `127.0.0.1` because its API can execute tools and shell commands. The Docker composition preserves that restriction instead of publishing a container port or binding the application to a network interface.

Host mode uses three hops: host Tailscale Serve terminates tailnet HTTPS, a loopback-only Caddy proxy authorizes configuration requests from one Tailscale login, and the containerized Harness listens on a second loopback port. Tailscale Serve strips client-supplied identity headers and supplies the authenticated `Tailscale-User-Login`; Caddy rewrites `Host` and `Origin` to loopback only for the configured owner and privileged RPC paths. Other requests retain the tailnet authority and continue through the Harness browser-trust checks.

The Harness `--trusted-host` option is a DNS-rebinding and cross-site fence, not authentication. Tailnet ACLs control access to the GUI. The Caddy rule limits settings, credentials, model discovery, preset management, and native host operations to `TAILSCALE_OWNER`, but any tailnet user allowed to reach the GUI can run ordinary agent tools against the mounted host files.

## Files

| Path                 | Purpose                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `../Dockerfile`      | Runtime image containing the published `@deepseek-ai/dsh` CLI                                     |
| `dsh-entrypoint.sh`  | Starts `dsh web`, exposes mounted toolchains, and optionally joins a container-owned tailnet node |
| `docker-compose.yml` | Host-network composition, host development mounts, USB access, and proxy                          |
| `Caddyfile`          | Loopback identity proxy for owner-only configuration RPCs                                         |
| `../run-docker.sh`   | Discovers host toolchains, builds, starts, verifies, and publishes the composition                |
| `../.dockerignore`   | Excludes unnecessary build-context files                                                          |
| `browser-e2e/`       | Reproducible Chromium runtime for the web browser e2e lane (`pnpm run test:web`)                  |
| `browser-e2e/run.sh` | Builds that runtime and runs the lane against the current checkout                                |

## Build

```sh
docker build -t dsh-tailscale:local -f Dockerfile .
```

The image installs the published `@deepseek-ai/dsh` package, its runtime peers, and pnpm for profile-plugin management from npm. `DSH_VERSION` defaults to `0.1.0-rc.8`, while `PNPM_VERSION` matches the repository's `packageManager`; update either build argument when its pinned release changes. `run-docker.sh` uses Compose's layer cache by default, so an unchanged relaunch skips the package-install layers; set `DSH_BUILD_NO_CACHE=1` only when an explicit clean rebuild is required.

## Host requirements

The launcher requires:

- a Linux host already logged into Tailscale, with Node.js, pnpm, Git, curl, `flock`, and `readlink` on `PATH`; and
- a container runtime plus Compose — Docker, or podman with `docker-compose`/`podman-compose`; and
- a repository checkout with a lockfile. Before stopping its existing composition, the launcher rejects a `web` profile that lists both `@linxin666/dsh-web-ui-all` and `dsh-better-sidebar` when the installed aggregate declares that sidebar dependency, printing the exact `dsh plugin remove` command. It then runs `pnpm install --frozen-lockfile` and `pnpm run build` in the checkout and verifies the web frontend dist and every client package's `lib/client.js` before building the image. Installation, compilation, or missing-artifact failures leave the services stopped instead of exposing a process to partially replaced dependencies or assets.

The launcher uses the first reachable container engine with a working Compose provider: Docker with its Compose plugin, then `podman compose`, then the `podman-compose` wrapper. A bare `docker` executable cannot mask a working podman installation. On SELinux hosts (Fedora enables it by default) both services set `label=disable` so the container may read the bind-mounted home and toolchains without relabeling them. Under rootless podman the launcher's generated override adds `userns_mode: keep-id`, which maps the invoking user's uid 1:1 into the container so files the agent creates in the mounted home belong to that user on the host. The container drops to the uid and gid that own `DSH_HOST_USER_HOME` (`DSH_UID`/`DSH_GID`), so hosts whose user is not uid 1000 work unchanged.

The development toolchains are optional. The launcher discovers Flutter and Java from `PATH`, and the Android SDK from `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Android/Sdk`, `~/android-sdk`, `/usr/lib/android-sdk`, or `/opt/android-sdk`. A missing toolchain prints a warning and launches without it: the container then has no `flutter`, `adb`, or `java`, and no related mounts. An override that names a path without the expected executable (`DSH_HOST_FLUTTER_HOME`, `DSH_HOST_ANDROID_HOME`, `DSH_HOST_JAVA_HOME`) is skipped the same way.

Allow the current user to manage Tailscale Serve once if required:

```sh
sudo tailscale set --operator="$USER"
```

### Fedora notes

```sh
sudo dnf install podman docker-compose   # rootless podman + compose provider
systemctl --user enable --now podman.socket   # lets docker-compose talk to podman
loginctl enable-linger "$USER"           # keeps containers running after logout
```

Rootless podman shares the host network namespace in `network_mode: host`, so both loopback services and the host's `tailscaled` interoperate exactly as under Docker. The `podman-docker` alias package is not required; auto-detection recognizes its compatibility shim and selects the real podman engine so rootless `keep-id` still applies. Set `DSH_CONTAINER_RUNTIME=podman` to make that choice explicit.

## Run on the host's Tailscale node

```sh
export DEEPSEEK_API_KEY=sk-...   # optional until a model request
./run-docker.sh
```

The launcher installs and builds the mounted checkout, derives `DSH_HOST_FLUTTER_HOME`, `DSH_HOST_ANDROID_HOME`, and `DSH_HOST_JAVA_HOME` from the discovered toolchains (printing one summary line), reads the host's MagicDNS name, tailnet IPv4, and login from `tailscale status`, builds the image, starts both loopback services, and verifies that an unrelated login receives HTTP 403 while the owner receives HTTP 200. It trusts the MagicDNS name and the tailnet IPv4 at the harness browser-trust fences and publishes `https://<host>.<tailnet>.ts.net/` only after those checks pass.

The optional `@linxin666/dsh-client-ui-task-board` keeps its control routes behind an additional proxy token. Configure its aggregate row to admit the launcher's trusted authorities; the launcher generates the token and gives it only to the Host and Caddy, which injects it after matching `TAILSCALE_OWNER`:

```yaml
- id: web-ui-task-board
  config:
    trustedProxyHosts: !!js (process.env.DSH_TRUSTED_HOSTS ?? '').split(/[,\s]+/).filter(Boolean)
```

The host home is mounted read-write at the same path inside the container. The launcher also writes a per-launch Compose override file mounting the JDK read-only, plus the Android SDK, the repository, udev data, and the USB bus — each only when it exists on the host, because Compose cannot express a conditional bind mount and would otherwise let the daemon create an empty root-owned directory at the missing path. Toolchains that already live under the mounted home need no extra mount. The entrypoint links `flutter`, `dart`, `adb`, and `java` into `/usr/local/bin` when their SDKs are available, because login shells may reset `PATH`.

Set `DSH_HOST_USER_HOME` when the host home is not `$HOME`, `DSH_HOST_WORKSPACE` to override the agent working directory (default `$HOME/git`, falling back to `$HOME` with a warning), and `DSH_HOST_FLUTTER_HOME`, `DSH_HOST_ANDROID_HOME`, or `DSH_HOST_JAVA_HOME` to override toolchain discovery.

## Run as a separate tailnet node

Set `TS_AUTHKEY` before invoking Compose directly when the container should own a separate Tailscale identity:

```sh
export DEEPSEEK_API_KEY=sk-...
export TS_AUTHKEY=tskey-auth-...
export TS_HOSTNAME=dsh
export DSH_HOST_USER_HOME="$HOME"
export DSH_HOST_FLUTTER_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v flutter)")")")"
export DSH_HOST_JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(command -v java)")")")"
docker compose -f docker/docker-compose.yml up -d --build
```

The entrypoint starts its bundled `tailscaled`, derives that node's MagicDNS name, adds it as a trusted host, and serves HTTPS from the container-owned tailnet node. The `tsstate` volume retains the node identity. The Caddy service remains a loopback endpoint but is not the serving path in this mode.

A direct Compose invocation skips the launcher-generated override file, so it mounts only the host home: toolchains outside `$HOME` (a JDK, the Android SDK, udev, USB) are unavailable inside the container until you add their mounts yourself or run `./run-docker.sh`.

## Environment reference

| Variable                | Default                 | Meaning                                                       |
| ----------------------- | ----------------------- | ------------------------------------------------------------- |
| `DEEPSEEK_API_KEY`      | _(unset)_               | Model credential; the GUI can start without it                |
| `DEEPSEEK_BASE_URL`     | _(unset)_               | Optional DeepSeek-compatible endpoint                         |
| `DSH_PUBLIC_PORT`       | `4080`                  | Host loopback port for Caddy and Tailscale Serve              |
| `DSH_BACKEND_PORT`      | `4081`                  | Host loopback port for `dsh web`; must differ from the public port |
| `DSH_CONTAINER_RUNTIME` | `auto`                  | `auto`, `docker`, or `podman`; the selected engine must be reachable |
| `DSH_BUILD_NO_CACHE`    | `0`                     | Set to `1` for an explicit clean image rebuild                |
| `DSH_STARTUP_TIMEOUT`   | `90`                    | Seconds to wait for the health-gated auth proxy               |
| `DSH_HOST_USER_HOME`    | `$HOME` in the launcher | Host home mounted read-write at the same container path       |
| `DSH_UID` / `DSH_GID`   | owner of the host home  | Container uid/gid for the harness process (set by the launcher) |
| `DSH_HOST_WORKSPACE`    | `$HOME/git`, else `$HOME` | Agent working directory inside the container              |
| `DSH_HOST_FLUTTER_HOME` | derived from `flutter` on `PATH` | Flutter SDK path; empty when absent, leaving the container without Flutter |
| `DSH_HOST_ANDROID_HOME` | discovered (see Host requirements) | Android SDK path; empty when absent, leaving the container without `adb` |
| `DSH_HOST_JAVA_HOME`    | derived from `java` on `PATH` | Host JDK path; empty when absent, leaving the container without Java |
| `DSH_TRUSTED_HOSTS`     | _(unset)_               | Additional API authorities appended to the host MagicDNS name and tailnet IPv4 (both pre-filled by the launcher) |
| `DSH_TASK_BOARD_PROXY_TOKEN` | random per launcher run | Internal credential shared by the task-board Host route and owner-authenticated Caddy proxy |
| `TAILSCALE_OWNER`       | host Tailscale login    | Login allowed to use owner-only RPC paths through Caddy       |
| `TS_AUTHKEY`            | _(unset)_               | Auth key enabling the container-owned-node mode               |
| `TS_HOSTNAME`           | `dsh` in Compose        | Container-owned Tailscale node name                           |
| `TS_EXTRA_ARGS`         | _(unset)_               | Additional `tailscale up` arguments                           |
| `TS_USERSPACE`          | `1`                     | Uses userspace networking for a container-owned node          |

## Keeping the fork up to date

```sh
./upstream-merge.sh
```

The script merges `upstream/master` into `master`, re-pins the image's `DSH_VERSION` to the merged release, reinstalls dependencies when the lockfile changed, and typechecks. On conflict it leaves the in-progress merge with the conflicted file list (bilingual pairs are resolved with `pnpm run resolve-translation-pairing-conflicts`); rerun it after committing a manual resolution. It never pushes — review, then `git push`.

The Docker utility stays outside product packages so upstream merges normally have a small conflict surface.

## Limitations

- The image runs the published packages at `DSH_VERSION`, not the current monorepo source.
- A new loopback-only RPC must be added to the Caddy owner matcher before it becomes remotely configurable; omission fails closed with HTTP 403.
- Host mode is intentionally machine-specific and grants the container read-write access to the host home. Restrict GUI reachability to tailnet identities trusted to execute shell commands against that data.

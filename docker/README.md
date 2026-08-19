# DeepSeek Harness in Docker, served over Tailscale

English | [中文](README.zh.md)

This personal-fork utility runs the published DeepSeek Harness Web GUI (`dsh web`) in a container with the host's repositories, Flutter, Android, Java, and USB device access.

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
| `../run-docker.sh`   | Validates the host, builds, starts, verifies, and publishes the composition                       |
| `../.dockerignore`   | Excludes unnecessary build-context files                                                          |
| `browser-e2e/`       | Reproducible Chromium runtime for the web browser e2e lane (`pnpm run test:web`)                   |
| `browser-e2e/run.sh` | Builds that runtime and runs the lane against the current checkout                                 |

## Build

```sh
docker build -t dsh-tailscale:local -f Dockerfile .
```

The image installs the published `@deepseek-ai/dsh` package, its runtime peers, and pnpm for profile-plugin management from npm. `DSH_VERSION` defaults to `0.1.0-rc.7`, while `PNPM_VERSION` matches the repository's `packageManager`; update either build argument when its pinned release changes.

## Host requirements

The launcher requires:

- a host already logged into Tailscale;
- repositories under `$HOME/git`;
- a Flutter executable on `PATH`;
- Android platform tools at `/usr/lib/android-sdk/platform-tools/adb`;
- a Java executable on `PATH`; and
- Docker Compose, Node.js, and curl.

Allow the current user to manage Tailscale Serve once if required:

```sh
sudo tailscale set --operator="$USER"
```

## Run on the host's Tailscale node

```sh
export DEEPSEEK_API_KEY=sk-...   # optional until a model request
./run-docker.sh
```

The launcher derives `DSH_HOST_FLUTTER_HOME` and `DSH_HOST_JAVA_HOME` from the host executables, reads the host's MagicDNS name, tailnet IPv4, and login from `tailscale status`, builds the image, starts both loopback services, and verifies that an unrelated login receives HTTP 403 while the owner receives HTTP 200. It trusts the MagicDNS name and the tailnet IPv4 at the harness browser-trust fences and publishes `https://<host>.<tailnet>.ts.net/` only after those checks pass.

The host home is mounted read-write at the same path inside the container, the host JDK is mounted read-only, and the Android SDK, udev data, and USB bus are mounted for device builds. The entrypoint links `flutter`, `dart`, `adb`, and `java` into `/usr/local/bin` because login shells may reset `PATH`.

Set `DSH_HOST_USER_HOME` when the host home is not `$HOME`, `DSH_HOST_FLUTTER_HOME` to override Flutter discovery, and `DSH_HOST_JAVA_HOME` to override Java discovery.

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

## Environment reference

| Variable                | Default                 | Meaning                                                       |
| ----------------------- | ----------------------- | ------------------------------------------------------------- |
| `DEEPSEEK_API_KEY`      | _(unset)_               | Model credential; the GUI can start without it                |
| `DEEPSEEK_BASE_URL`     | _(unset)_               | Optional DeepSeek-compatible endpoint                         |
| `DSH_PUBLIC_PORT`       | `4080`                  | Host loopback port for Caddy and Tailscale Serve              |
| `DSH_BACKEND_PORT`      | `4081`                  | Host loopback port for `dsh web`                              |
| `DSH_HOST_USER_HOME`    | `$HOME` in the launcher | Host home mounted read-write at the same container path       |
| `DSH_HOST_FLUTTER_HOME` | derived from `flutter`  | Flutter SDK path available inside the mounted host home       |
| `DSH_HOST_JAVA_HOME`    | derived from `java`     | Host JDK mounted read-only at the same container path         |
| `DSH_TRUSTED_HOSTS`     | _(unset)_               | Additional API authorities appended to the host MagicDNS name and tailnet IPv4 (both pre-filled by the launcher) |
| `TAILSCALE_OWNER`       | host Tailscale login    | Login allowed to use owner-only RPC paths through Caddy       |
| `TS_AUTHKEY`            | _(unset)_               | Auth key enabling the container-owned-node mode               |
| `TS_HOSTNAME`           | `dsh` in Compose        | Container-owned Tailscale node name                           |
| `TS_EXTRA_ARGS`         | _(unset)_               | Additional `tailscale up` arguments                           |
| `TS_USERSPACE`          | `1`                     | Uses userspace networking for a container-owned node          |

## Keeping the fork up to date

```sh
git fetch upstream
git merge upstream/master
git push origin master
```

The Docker utility stays outside product packages so upstream merges normally have a small conflict surface.

## Limitations

- The image runs the published packages at `DSH_VERSION`, not the current monorepo source.
- A new loopback-only RPC must be added to the Caddy owner matcher before it becomes remotely configurable; omission fails closed with HTTP 403.
- Host mode is intentionally machine-specific and grants the container read-write access to the host home. Restrict GUI reachability to tailnet identities trusted to execute shell commands against that data.

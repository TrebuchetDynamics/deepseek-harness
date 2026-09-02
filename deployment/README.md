# Native DeepSeek Harness service

English | [中文](README.zh.md)

`start.sh` installs the current checkout as the system-level `deepseek-harness.service`. Harness and Caddy run as the installing non-root user. Tailscale mode publishes the loopback identity proxy through Tailscale Serve; NetBird mode binds Caddy to the host's NetBird address for direct mesh access.

## Prerequisites

The host must use systemd and have a connected Tailscale or NetBird node. The service user's non-interactive login shell must provide Caddy 2, Node.js `^22.19.0 || >=24.0.0`, Git, curl, the selected VPN CLI, `setsid`, and `ss`; it must also provide either Corepack or pnpm `11.7.0`. The host needs `sudo`, `systemctl`, `systemd-analyze`, `runuser`, `getent`, `install`, `flock`, and `readlink`. On Ubuntu and Fedora, installation uses the configured APT or DNF repositories to install a missing Caddy package before checking versions. When pnpm is missing, the launcher activates the pinned version through Corepack. Other dependencies remain user-managed login-shell tools.

Configure the official [Caddy](https://caddyserver.com/docs/install), [Tailscale](https://tailscale.com/kb/installation), or [NetBird](https://docs.netbird.io/get-started/install/linux) repositories when their packages are unavailable from the configured repositories. The equivalent manual commands are:

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

Install a supported Node.js release with Corepack. The launcher activates pnpm `11.7.0` automatically; Node.js distributions without Corepack require a separate pnpm `11.7.0` installation.

## Install or update

Run the launcher as the non-root user who will own the Harness process:

```sh
./start.sh

# Override automatic VPN selection
DSH_VPN_PROVIDER=netbird ./start.sh
```

The launcher uses `sudo` only for missing Caddy package installation, exact owned-Docker takeover, systemd, root-owned configuration, and selected VPN setup. Without an explicit or saved provider, it selects a connected NetBird network before Tailscale and reports an error when neither is connected. It prints each install phase with a live spinner and elapsed time while hiding successful package-manager, build, and unit-verifier detail; `DSH_VERBOSE=1 ./start.sh` streams those commands for diagnosis. It prepares the current checkout in place through the user's login shell, retains that user's supplementary groups, builds before cutover, and waits for the systemd `Type=notify` readiness result. Listener checks accept any HTTP response because the token-protected root rejects unauthenticated requests. The supervisor captures the backend's launch URL in its private runtime directory and gives its token only to Caddy. On a clean root request without a Harness cookie, Caddy uses the Serve-injected `TAILSCALE_OWNER` identity to exchange that token for an authority-bound browser cookie; the identity proxy must also deny an unowned login and admit the owner before systemd reports readiness. Installation stores the resolved Node.js and pnpm paths in the unit, so restarts do not depend on systemd's default PATH. The root-owned launcher, proxy configuration, and verification helper live under `/usr/local/libexec/deepseek-harness`; the service still runs the checkout itself as the non-root user. The generated backend launcher remains non-executable and runs through Bash, so systemd runtime directories mounted with `noexec` are supported. After readiness, `start.sh` and `status` print the clean public URL while the enabled service continues in the background; the browser never needs the process launch token. A non-interactive caller without cached sudo authorization fails before changing Docker, systemd, or Serve state and names the interactive command to run. An update stops an owned native service before replacing checkout artifacts and restarts the installed service if the build fails. During a provider transition, route cleanup accepts a route that disappears after its ownership check; any other cleanup failure restarts the installed service and reports the error. During `install`, an otherwise valid deployment state without `provider` derives the installed provider from the matching root-owned unit; other commands reject the incomplete state.

When the exact Docker deployment from this checkout is running, `start.sh` invokes the local Docker CLI after the native build and ownership checks to remove its `dsh` and `auth-proxy` containers before startup; named volumes are preserved. It neither builds nor starts Docker, does not require Docker on a native-only host, and preserves containers from other checkouts. Other listeners, VPN operators, and Serve routes fail without being replaced. Takeover is one-way: if native readiness later fails, rerun `start.sh` after correcting the reported error; removed containers are not recreated.

The service receives the user's direct host permissions and login-shell tools rather than a curated container mount list. Membership in the `docker` group grants the agent host-root-equivalent authority through the Docker daemon; restrict VPN access accordingly.

## Operations

```sh
./start.sh start
./start.sh stop
./start.sh restart
./start.sh status
./start.sh logs
./start.sh uninstall
```

`status` prints systemd state and the native URLs. `logs` follows the system journal. `uninstall` removes only an owned unit and matching Serve route; it preserves `/etc/deepseek-harness.env` and `/var/lib/deepseek-harness/deployment.json`. Start, stop, restart, and uninstall refuse an installed unit or live route that does not match the root-owned deployment state.

## Configuration

Installation creates `/etc/deepseek-harness.env` once and preserves it across updates and uninstall. The file must remain a root-owned, non-symlink regular file without group or world write permission.

| Setting                   | Default                          | Meaning                                          |
| ------------------------- | -------------------------------- | ------------------------------------------------ |
| `DSH_VPN_PROVIDER`        | detected; NetBird preferred       | VPN transport: `tailscale` or `netbird`          |
| `DSH_BACKEND_PORT`        | `4081`                           | Loopback port for `dsh web`                      |
| `DSH_PUBLIC_PORT`         | `4080`                           | Caddy port; loopback Serve target in Tailscale mode |
| `DSH_HTTPS_PORT`          | `443`                            | Host Tailscale Serve HTTPS port                  |
| `DSH_STARTUP_TIMEOUT`     | `90`                             | Readiness timeout in seconds                     |
| `TAILSCALE_OWNER`         | connected login at first install | Login allowed to use owner-only proxy routes     |
| `DSH_EXTRA_TRUSTED_HOSTS` | empty                            | Comma-separated additional Harness trusted hosts |

Edit the file with root privileges and keep every required key exactly once. `TAILSCALE_OWNER` is required only for Tailscale mode. Apply VPN provider or port changes with `./start.sh install` so deployment state, service dependencies, and Serve ownership advance together; apply other changes with `./start.sh restart`. Ports must be distinct where required and lie between 1 and 65535; the startup timeout must be between 1 and 3600 seconds. The configured owner must match the connected host-node login.

## NetBird access

With no explicit or saved provider, installation selects NetBird when it is connected. Set `DSH_VPN_PROVIDER=netbird` to override detection, or edit the root-owned configuration and rerun `./start.sh install`. The host must already be connected with `netbird up`; the launcher never joins a network or stores a setup key. Caddy binds to the host's NetBird IPv4 address and prints only the reachable `http://<netbird-ip>:4080/` URL. It preserves that complete authority, including the non-default port, when forwarding browser authentication and API requests. NetBird ACL policies control which peers can reach it, while the Harness launch token exchanges for the normal browser cookie. NetBird has no local equivalent of Tailscale's injected user-login header, so the direct mesh mode does not claim per-user identity at the proxy.

## Tailscale authorization

Harness and Caddy bind only to `127.0.0.1`. Host Tailscale Serve terminates HTTPS and supplies the authenticated `Tailscale-User-Login`; [`Caddyfile`](Caddyfile) forwards the complete `/api/*` namespace only for `TAILSCALE_OWNER` and returns 403 for other identities. This namespace rule covers settings, sessions, every installed tool and plugin API, Remote SSH, and task-board control without a route allowlist that can become stale. Tailnet ACLs still decide who can reach the static GUI, but only the configured owner can use the Host API with the service user's permissions.

Installation assigns the Tailscale operator only when none exists and refuses a different operator. Publication and cleanup compare the HTTPS port and loopback target before changing Serve state. This mode always uses the host Tailscale node and does not accept `TS_AUTHKEY`.

## Limitations

- The managed service requires Linux, systemd, and a connected host Tailscale or NetBird node; dependency guidance covers Ubuntu, Fedora, and Arch. On SELinux hosts, installation restores the labels of the root-owned control files under `/usr/local/libexec` instead of asking systemd to execute a home-directory launcher.
- The launcher executes this checkout in place and does not install a published package or copy source into a private service directory.
- Native and Docker launchers cannot own the same ports or Serve route concurrently. Use [`run-docker.sh`](../run-docker.sh) only after stopping or uninstalling the native service.
- Ubuntu and Fedora installation may install the missing Caddy package after masking its package service for the transaction. It does not configure third-party repositories or install or upgrade other host packages; Arch reports the manual command instead.
- Uninstall preserves configuration and deployment state for inspection or later reinstallation.

# Native DeepSeek Harness service

English | [中文](README.zh.md)

`start.sh` installs the current checkout as the system-level `deepseek-harness.service`. Harness and Caddy run as the installing non-root user, and host Tailscale Serve publishes the loopback identity proxy.

## Prerequisites

The host must use systemd and have a connected host Tailscale node. The service user's non-interactive login shell must provide Caddy 2, Node.js `^22.19.0 || >=24.0.0`, Git, curl, Tailscale, `setsid`, and `ss`; it must also provide either Corepack or pnpm `11.7.0`. The host needs `sudo`, `systemctl`, `systemd-analyze`, `runuser`, `getent`, `install`, `flock`, and `readlink`. On Ubuntu and Fedora, installation uses the configured APT or DNF repositories to install a missing Caddy package before checking versions. When pnpm is missing, the launcher activates the pinned version through Corepack. Other dependencies remain user-managed login-shell tools.

Configure the official [Caddy](https://caddyserver.com/docs/install) and [Tailscale](https://tailscale.com/kb/installation) repositories when their packages are unavailable from the configured repositories. The equivalent manual commands are:

```sh
# Ubuntu
sudo apt install caddy tailscale iproute2 git curl util-linux coreutils

# Fedora
sudo dnf install caddy tailscale iproute git curl util-linux coreutils

# Arch
sudo pacman -S caddy tailscale iproute2 git curl util-linux coreutils
```

Install a supported Node.js release with Corepack. The launcher activates pnpm `11.7.0` automatically; Node.js distributions without Corepack require a separate pnpm `11.7.0` installation.

## Install or update

Run the launcher as the non-root user who will own the Harness process:

```sh
./start.sh
```

The launcher uses `sudo` only for missing Caddy package installation, exact owned-Docker takeover, systemd, root-owned configuration, and Tailscale setup. It prints each install phase with a live spinner and elapsed time while hiding successful package-manager, build, and unit-verifier detail; `DSH_VERBOSE=1 ./start.sh` streams those commands for diagnosis. It prepares the current checkout in place through the user's login shell, retains that user's supplementary groups, builds before cutover, and waits for the systemd `Type=notify` readiness result. Listener checks accept any HTTP response because the token-protected root rejects unauthenticated requests. The supervisor captures the backend's launch URL in its private runtime directory, exchanges that token through Caddy for an authority-bound browser cookie, and requires the identity proxy to deny an unowned login and admit `TAILSCALE_OWNER` before systemd reports readiness. Installation stores the resolved Node.js and pnpm paths in the unit, so restarts do not depend on systemd's default PATH. The root-owned launcher, proxy configuration, and verification helper live under `/usr/local/libexec/deepseek-harness`; the service still runs the checkout itself as the non-root user. The generated backend launcher remains non-executable and runs through Bash, so systemd runtime directories mounted with `noexec` are supported. After readiness, `start.sh` prints the public URL with the current process launch token and returns to the invoking shell while the enabled service continues in the background; `status` prints the clean URL without repeating the token. A non-interactive caller without cached sudo authorization fails before changing Docker, systemd, or Serve state and names the interactive command to run. An update stops an owned native service before replacing checkout artifacts and restarts the installed service if the build fails.

When the exact Docker deployment from this checkout is running, `start.sh` invokes the local Docker CLI after the native build and ownership checks to remove its `dsh` and `auth-proxy` containers before startup; named volumes are preserved. It neither builds nor starts Docker, does not require Docker on a native-only host, and preserves containers from other checkouts. Other listeners, Tailscale operators, and Serve routes fail without being replaced. Takeover is one-way: if native readiness later fails, rerun `start.sh` after correcting the reported error; removed containers are not recreated.

The service receives the user's direct host permissions and login-shell tools rather than a curated container mount list. Membership in the `docker` group grants the agent host-root-equivalent authority through the Docker daemon; restrict tailnet access accordingly.

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
| `DSH_BACKEND_PORT`        | `4081`                           | Loopback port for `dsh web`                      |
| `DSH_PUBLIC_PORT`         | `4080`                           | Loopback port for Caddy and the Serve target     |
| `DSH_HTTPS_PORT`          | `443`                            | Host Tailscale Serve HTTPS port                  |
| `DSH_STARTUP_TIMEOUT`     | `90`                             | Readiness timeout in seconds                     |
| `TAILSCALE_OWNER`         | connected login at first install | Login allowed to use owner-only proxy routes     |
| `DSH_EXTRA_TRUSTED_HOSTS` | empty                            | Comma-separated additional Harness trusted hosts |

Edit the file with root privileges and keep every key exactly once. Apply port changes with `./start.sh` so deployment state and Serve ownership advance together; apply other changes with `./start.sh restart`. Ports must be distinct where required and lie between 1 and 65535; the startup timeout must be between 1 and 3600 seconds. The configured owner must match the connected host-node login.

## Tailscale authorization

Harness and Caddy bind only to `127.0.0.1`. Host Tailscale Serve terminates HTTPS and supplies the authenticated `Tailscale-User-Login`; [`Caddyfile`](Caddyfile) preserves the browser authority for settings, credentials, model discovery, preset management, native host operations, Remote SSH, and task-board control routes, forwards them for `TAILSCALE_OWNER`, and returns 403 for other identities. Tailnet ACLs still decide who can reach the GUI, and every admitted GUI user can run ordinary agent tools with the service user's host permissions.

Installation assigns the Tailscale operator only when none exists and refuses a different operator. Publication and cleanup compare the HTTPS port and loopback target before changing Serve state. This mode always uses the host Tailscale node and does not accept `TS_AUTHKEY`.

## Limitations

- The managed service requires Linux, systemd, and the host Tailscale node; dependency guidance covers Ubuntu, Fedora, and Arch. On SELinux hosts, installation restores the labels of the root-owned control files under `/usr/local/libexec` instead of asking systemd to execute a home-directory launcher.
- The launcher executes this checkout in place and does not install a published package or copy source into a private service directory.
- Native and Docker launchers cannot own the same ports or Serve route concurrently. Use [`run-docker.sh`](../run-docker.sh) only after stopping or uninstalling the native service.
- Ubuntu and Fedora installation may install the missing Caddy package after masking its package service for the transaction. It does not configure third-party repositories or install or upgrade other host packages; Arch reports the manual command instead.
- Uninstall preserves configuration and deployment state for inspection or later reinstallation.

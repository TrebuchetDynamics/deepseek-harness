# Native DeepSeek Harness Service Design

## Status

Approved design for implementation planning.

## Objective

Provide `start.sh` as a host-native alternative to `run-docker.sh`. It installs and manages `deepseek-harness.service`, gives agents the installing user's full host permissions and login environment, starts at boot, and preserves the Docker deployment's host-node Tailscale identity and owner-only route behavior.

## Supported systems

The first supported platform set is systemd-based Ubuntu, Fedora, and Arch Linux. The launcher validates required software and prints distribution-specific installation guidance but never invokes a package manager. The host must provide a supported Node.js version, the repository's pinned pnpm version, Git, curl, Caddy, Tailscale, systemd, and standard Linux account and file utilities.

The service uses the host's existing connected Tailscale node. A service-owned `tailscaled` instance and `TS_AUTHKEY` mode are outside this design.

## User interface

`start.sh` accepts the following commands:

```text
./start.sh                 # install or update, enable, and start
./start.sh install         # same behavior as no arguments
./start.sh start
./start.sh stop
./start.sh restart
./start.sh status
./start.sh logs
./start.sh uninstall
```

Installation and updates consume the checkout containing `start.sh`; they do not copy the repository or install the published npm package. Moving the checkout requires rerunning installation so the unit receives the new canonical path.

`start`, `stop`, and `restart` delegate to systemd after validating that the installed unit belongs to this launcher. `status` reports the unit state and local and tailnet URLs. `logs` follows the unit journal. `uninstall` disables and removes the service-owned unit and Serve route but preserves `/etc/deepseek-harness.env`.

## Runtime architecture

The installer writes `/etc/systemd/system/deepseek-harness.service`. The unit runs as the invoking non-root user and starts `start.sh __service`; `__service` is an internal entry point rejected outside the rendered unit arguments.

The wrapper supervises two processes in one systemd cgroup:

1. `pnpm dsh web --no-open` binds `127.0.0.1:${DSH_BACKEND_PORT}`.
2. Caddy binds `127.0.0.1:${DSH_PUBLIC_PORT}` and reverse-proxies to the backend with the shared Tailscale identity policy.

Host Tailscale Serve publishes `https://<MagicDNS>/` on `DSH_HTTPS_PORT` to the loopback Caddy endpoint. Harness trusts the MagicDNS name, the host's Tailscale IPv4 address, and configured extra trusted hosts.

The Caddy policy preserves normal remote restrictions for requests not carrying the configured owner's Serve-injected identity. Requests from `TAILSCALE_OWNER` may use settings, credentials, model discovery, agent-preset management, native-host operations, skill explorer, Remote SSH, and task-board control routes. The wrapper creates a task-board proxy token for each service start and exposes it only to Harness and Caddy.

The wrapper reports systemd readiness only after all of the following succeed:

- Harness answers through its loopback backend.
- Caddy answers through its loopback listener.
- an unauthorized identity receives HTTP 403 from an owner-only route;
- `TAILSCALE_OWNER` receives HTTP 200 from the same route;
- the published MagicDNS HTTPS URL is reachable.

If Harness or Caddy exits, the wrapper terminates the sibling and exits so systemd restarts the complete service. Signal cleanup removes a Serve route only when the live target still matches the service-owned target.

## Shared deployment policy

Native and Docker launchers share checkout validation, duplicate-profile rejection, Tailscale status and identity parsing, owner-sensitive proxy policy, readiness probes, and deployment locking. Shared shell helpers live under `scripts/deployment/`; the identity-aware Caddyfile moves to a deployment-neutral path consumed by both launchers.

The shared lock lives under the selected user's `~/.dsh` directory so unprivileged Docker and native launchers cannot mutate the checkout or Tailscale route concurrently.

Platform-specific process supervision, systemd rendering, Docker runtime selection, and Compose generation remain in their owning launcher.

## Installation and update ordering

Installation performs the following operations in order:

1. Resolve the invoking non-root service user, canonical checkout, home, primary group, supplementary groups, and login shell.
2. Acquire the shared deployment lock.
3. Validate systemd, dependencies, Tailscale connectivity, existing operator ownership, configuration ownership, ports, and route ownership.
4. Run dependency and build probes through the service user's login environment.
5. Reject duplicate sidebar bundles.
6. Run `pnpm install --frozen-lockfile`, `pnpm run build`, and required-artifact checks as the service user.
7. Render the root-owned configuration and unit into temporary files, validate them, and atomically install them.
8. Migrate an owned Docker deployment when present.
9. Reload systemd, enable and start the unit, and wait for service readiness.

Dependency installation, build, and rendered-file validation complete before a running deployment stops. Boot startup consumes existing artifacts and performs no package installation, build, or network download.

Reinstallation is idempotent. An unchanged valid configuration remains intact; a changed unit is atomically replaced. Failure before migration leaves the running deployment unchanged.

## Login environment and host permissions

The installer and service execute tool resolution and Harness through the target user's login environment. The implementation must support the login shells exercised by the Ubuntu, Fedora, and Arch validation matrix and fail with a corrective diagnostic for unsupported shells or startup files that prevent non-interactive execution.

The systemd unit sets `User=`, `Group=`, `HOME`, `USER`, `DSH_HOME`, the canonical working directory, `UMask=0077`, restart policy, startup and stop timeouts, and `KillMode=mixed`. It retains the account's supplementary groups. It does not add filesystem, device, network, namespace, capability, or `NoNewPrivileges` restrictions that would reduce the user's ordinary host access.

The agent remains non-root. The launcher does not grant new group memberships, credentials, sudo rights, device permissions, or filesystem access; it exposes the permissions the service user already has.

## Configuration and state

`/etc/deepseek-harness.env` is a root-owned, non-symlink regular file that is not group- or world-writable. Installation rejects ownership or mode violations instead of replacing the file. It defines:

```text
DSH_BACKEND_PORT=4081
DSH_PUBLIC_PORT=4080
DSH_HTTPS_PORT=443
DSH_STARTUP_TIMEOUT=90
TAILSCALE_OWNER=<installing user's Tailscale login>
DSH_EXTRA_TRUSTED_HOSTS=
```

The launcher validates integer ranges, distinct backend and public ports, owner syntax, newline-free systemd values, and absolute canonical paths.

A root-owned state file under `/var/lib/deepseek-harness/` records the canonical checkout, service user, expected loopback target, Serve port, and deployment identity. The launcher updates it atomically after readiness. Cleanup and migration compare this record with live systemd, Tailscale, and container state before changing external resources.

Ephemeral runtime credentials and PID metadata live under a systemd-created `/run/deepseek-harness/` directory accessible only to the service user.

## Tailscale ownership

Installation enables and requires the existing `tailscaled.service` but never runs `tailscale up`. It requires a connected backend, MagicDNS name, and Tailscale IPv4 address.

If no Tailscale operator exists, installation assigns the service user. If another operator exists, installation fails rather than replacing it. The service never overwrites an occupied HTTPS Serve port unless ownership is proven as either the installed native service or the exact Docker Harness deployment being migrated.

Caddy binds loopback only. Tailnet ACLs remain the outer access control. The owner-sensitive proxy is authorization for privileged HTTP routes, not authentication for the entire GUI.

## Docker migration and rollback

Automatic migration applies only when all of the following are true:

- Docker Compose identifies `dsh` and `auth-proxy` containers from this canonical checkout and Compose project;
- container labels and configured working directory match the checkout;
- Tailscale Serve points the selected HTTPS port to the expected loopback public port;
- no unrelated listener or service owns the native unit, ports, or route.

After native preflight and build succeed, the launcher records the exact container IDs and stops them without removing them. It starts and verifies the native service while the Serve route retains the same loopback target.

If native startup or verification fails, the launcher stops the native unit, restores the exact recorded containers, verifies the Docker endpoint, and reports the native failure and rollback result separately. A failed rollback is a hard error with both service and container diagnostics.

After native readiness succeeds, the launcher removes the stopped Compose services without deleting named volumes. It records native ownership only after that cleanup succeeds. Ambiguous ownership fails closed and prints the exact manual inspection and cleanup commands.

Uninstall does not restore Docker automatically because the migrated containers have been removed after successful cutover.

## Failure behavior

Every validation error names the failed executable, path, account, port, route, owner, or HTTP status and provides the corrective action when it is not self-evident. The launcher emits diagnostics from systemd, the Harness and Caddy processes, Tailscale Serve status, and Docker containers without printing task-board tokens or credentials.

The installer never leaves a partially written unit or configuration file. A failure after unit installation disables the invalid unit or restores the preceding valid unit before returning. It does not remove or rewrite unowned Tailscale routes, operators, systemd units, containers, or configuration files.

## Verification

`scripts/start.spec.ts` runs the real launcher against stubbed systemd, Tailscale, Caddy, Docker/Compose, account, login-shell, and checkout commands. It covers:

- Ubuntu, Fedora, and Arch dependency diagnostics;
- unit, configuration, and state rendering;
- idempotent installation and update ordering;
- non-root refusal and login-environment propagation;
- backend, proxy, identity, and Tailscale readiness;
- signal cleanup and sibling-process failure;
- operator, route, port, state, symlink, ownership, and mode conflicts;
- Docker ownership proof, successful migration, rollback, rollback failure, and unrelated-container refusal;
- start, stop, restart, status, logs, and uninstall.

Focused tests use real temporary sockets and HTTP servers where the observable behavior does not require privileged system services. Shell syntax, lint, documentation pairing, and whitespace checks cover their changed files.

A release claiming the full platform set requires manual native install, reboot persistence, update, Docker migration, rollback exercise, and uninstall smokes on current Ubuntu, Fedora, and Arch hosts. Platform evidence records distribution version, systemd version, Tailscale version, Caddy version, Node version, pnpm version, and login shell.

## Documentation and decision records

Implementation adds a bilingual native-deployment guide and links it from the root deployment choices. Docker documentation links to the native alternative and states that the launchers cannot run concurrently.

A new Agent Note records direct access to the user's complete host environment as the reason for the native service. The implementation audits the active note that removes the native launcher and archives or supersedes it according to Agent Note policy rather than editing frozen history.

## Out of scope

- non-systemd Linux, macOS, and Windows services;
- automatic OS package installation;
- downloading or vendoring Node.js, pnpm, Caddy, or Tailscale binaries;
- a service-owned Tailscale node or `TS_AUTHKEY`;
- concurrent Docker and native Harness deployments on the same ports;
- automatic Docker restoration during uninstall;
- granting the service user permissions it does not already possess.

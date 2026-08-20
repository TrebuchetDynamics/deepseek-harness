# Agent Note: Persistent host Web service

Status: implemented

English | [中文](2026-08-20-host-web-systemd-service.zh.md)

## Problem

The foreground Web launcher stops with its shell and does not return after a reboot or process failure. The container launcher supplies persistence but isolates the agent from host toolchains, devices, credentials, and workspaces that are intentionally available to a host-native deployment. Running an agent-capable process as root would turn installation privilege into permanent runtime privilege.

## Decision

`run-web.sh` installs and manages a systemd system service on Fedora and Ubuntu. The installer uses `sudo` only for the unit, root-owned configuration, `tailscaled`, and the one-time Tailscale operator grant; the service runs the checkout as the invoking non-root account with explicit `HOME`, `DSH_HOME`, working directory, Node, pnpm, and `PATH` values. Direct root installation is rejected unless a non-root service account is named explicitly.

The installer enables the repository-pinned pnpm through Corepack when pnpm is absent, then runs `pnpm install --frozen-lockfile` and `pnpm run build` as the service account. Boot never installs dependencies or compiles artifacts. The system unit starts after `tailscaled`, restarts after failure, and reports readiness only after its owned Web child passes a DSH API probe and both Tailscale Serve routes become reachable.

The service owns its configured Serve ports. Startup refuses to replace routes found before the unit is installed, and shutdown removes both routes before awaiting its child. Installation also refuses to replace a different Tailscale operator. `/etc/dsh-web.env` contains the portable scalar configuration shared by Fedora and Ubuntu; lifecycle commands expose install, start, stop, restart, status, logs, foreground run, and uninstall operations.

Tailscale policy remains the access-control authority. Trusted-host arguments permit the expected Host and Origin values but do not authenticate a tailnet user.

## Alternatives considered

**Keep the foreground launcher.** A shell-attached process is useful for diagnostics but cannot satisfy boot persistence, supervised restart, or deterministic route cleanup.

**Use only the container launcher.** Containers provide a reproducible deployment but cannot expose the complete host environment without broad mounts and device mappings that erase much of that isolation. Both deployment modes remain available because they optimize different trust and portability requirements.

**Install a system service that runs as root.** This simplifies access to the unit and Tailscale but also gives every agent tool and subprocess root authority. Privilege is confined to installation instead.

**Install a user unit with lingering.** A user unit requires distribution- and account-specific linger setup and still needs privileged Tailscale operator configuration. A system unit with `User=` has one boot lifecycle while preserving an unprivileged runtime identity.

## Consequences

A prepared source checkout can survive logout, reboot, and process failure while retaining direct host access. Moving or deleting the checkout makes startup fail until the service is reinstalled from its new path. The selected non-root account becomes the Tailscale operator, and an existing different operator or Serve route must be resolved explicitly. Stopping the service intentionally removes its configured exposure, so those Serve ports cannot be shared with an unrelated application.

Focused launcher tests exercise lifecycle help, unit rendering, path escaping, line-break rejection before privileged unit installation, and systemd verification when `systemd-analyze` is available. Real Fedora and Ubuntu hosts remain the authority for installation, reboot, Tailscale certificate, and network reachability behavior.

# Agent Note: Native DeepSeek Harness service

Status: implemented

English | [中文](2026-08-24-native-deepseek-harness-service.zh.md)

## Problem

A container can access only the host paths, sockets, devices, and environment explicitly exposed to it. Even a broad Harness composition omits login-shell tools, host services, credentials, and devices that were not predicted when its mounts were defined, so an agent can report host capabilities such as Docker as absent or behave differently from the invoking user. The concrete requirement for unrestricted access satisfies the reintroduction condition recorded by the archived [host-launcher removal decision](../../archived/simplification/2026-08-22-remove-host-web-launcher.md).

## Decision

The repository ships `start.sh` as a direct-host alternative to `run-docker.sh`; invoking it without a command installs or updates the service. It installs one system-level `deepseek-harness.service` for the current checkout, while systemd runs the service as the invoking non-root user with that user's home, login shell, primary group, and supplementary groups. Root-owned launcher and proxy files under `/usr/local/libexec/deepseek-harness` keep systemd execution outside home-directory SELinux labels while the backend still executes the checkout in place. One wrapper supervises the Harness backend and Caddy, publishes the loopback proxy through the host Tailscale node, and reports readiness only after backend, proxy, owner-authorization, and tailnet HTTPS probes succeed.

Docker and native deployment share checkout preparation, profile rejection, Tailscale identity parsing, deployment locking, identity-proxy probing, and `deployment/Caddyfile`. A native installation replaces Docker only after Compose labels prove the canonical checkout, Compose files, and exact `dsh` and `auth-proxy` services, and after the active Serve target matches the shared loopback proxy. It stops exact container IDs, removes them only after native readiness, and restarts the same IDs when native readiness fails. The Docker launcher rejects an active native unit before stopping its composition.

Root privileges are limited to dependency inspection and Ubuntu or Fedora package installation, atomic root-owned launcher and configuration files, systemd operations, deployment state, and Tailscale setup. The runtime configuration and deployment state must be root-owned non-symlink files without group or world write permission. Lifecycle commands compare the installed unit and live Serve route with deployment state before changing or removing them. Existing unrelated Tailscale operators, routes, Docker labels, and loopback listeners fail closed.

## Alternatives considered

**Docker-only deployment with additional mounts.** Rejected: explicit mounts still require predicting every future tool, service, credential, socket, and device, which does not provide the requested equivalence with the user's host environment.

**Restore a standalone host launcher with independent policy.** Rejected: duplicated build, identity, readiness, and route logic created the maintenance risk identified by the archived removal decision. Shared deployment helpers keep the two execution modes aligned.

**Use multiple systemd units for Harness, Caddy, and publication.** Rejected: independent units complicate readiness, task-board token ownership, failure propagation, and cleanup. One notifying service owns the complete runtime lifetime.

**Install a published npm package into a private service directory.** Rejected: the deployment requirement is to execute the current checkout in place so local plugins, builds, and updates are the service source.

## Consequences

The agent receives the service user's direct file, credential, device, host-service, and login-shell access. Supplementary groups are retained; a user in the `docker` group gives the agent host-root-equivalent authority through the Docker daemon. Tailnet ACLs and the owner-only Caddy routes therefore remain part of the security model, not merely network convenience.

The managed path requires Linux, systemd, a host Tailscale node, and Caddy. Ubuntu and Fedora installations add a missing Caddy package through configured APT or DNF repositories before version checks. The launcher temporarily masks the package service, then disables and unmasks it so only `deepseek-harness.service` owns the proxy process. Other tools remain owned by the service user's login shell. Installation emits named phases and returns after systemd readiness; the enabled service then persists independently in the background. Non-interactive sudo failure occurs before deployment mutation and points to the interactive invocation. Manual dependency guidance also covers Arch. Native and Docker deployments cannot run concurrently on the owned ports and Serve route. Configuration and ownership state survive uninstall so administrators can inspect or reuse them.

The shared implementation reduces policy drift but does not remove platform-specific validation work. Ubuntu, Fedora, and Arch install, reboot, update, migration, rollback, and uninstall smokes remain required before each distribution is claimed as manually certified.

## Verification

`scripts/start.spec.ts` exercises the documented zero-argument install default and CLI completion message, Ubuntu and Fedora missing-Caddy installation and existing-service preservation, real systemd unit verification, root-PATH-independent login-shell Node and pnpm resolution, fresh-install cleanup, port-change rejection, installation ordering, non-root unit rendering, login-shell execution, update stop and rollback, Type=notify runtime supervision, authorization readiness, exact Docker migration and rollback, operator, route, listener, configuration and unit ownership failures, diagnostic redaction, lifecycle cleanup, and Arch dependency guidance. `scripts/run-docker.spec.ts` pins the shared policy, build-before-image behavior, host Docker exposure, and active-native exclusion. Bash syntax validation covers both launchers and their shared helpers. Ubuntu 24.04 and Fedora 42 container runs install their distribution systemd package and accept the rendered unit with `systemd-analyze verify`; this checks parser portability, not service startup.

No real Ubuntu, Fedora, or Arch systemd host is available in the current containerized development environment, so this record does not claim those manual platform smokes.

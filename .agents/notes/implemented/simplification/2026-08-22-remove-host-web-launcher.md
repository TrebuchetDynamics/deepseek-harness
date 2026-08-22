# Agent Note: Remove the host-native Web service launcher

Status: implemented

English | [中文](2026-08-22-remove-host-web-launcher.zh.md)

## Problem

The repository carried two machine deployment utilities that each installed or consumed the source checkout, managed Tailscale Serve, and exposed the Web UI. The host-native path additionally owned systemd unit generation, root configuration, Tailscale operator changes, route-conflict checks, and a dedicated test harness. Maintaining both launchers duplicated lifecycle and security-sensitive deployment behavior.

## Decision

The repository ships `run-docker.sh` as its machine deployment utility and removes `run-web.sh`, its dedicated tests, and its root README instructions. The ordinary `pnpm dsh web` command remains the foreground host-native path for development and diagnostics.

This decision consolidates the removed launcher's motivation and guarantees. The host service provided reboot persistence and direct access to host tools while keeping the agent process non-root; privileged operations were limited to installation, systemd, and Tailscale configuration, and existing operators or Serve routes were never overwritten. Those guarantees no longer justify a parallel implementation because the Docker launcher mounts the selected home, workspace, toolchains, and devices while supervising one composition. Existing systemd units are external machine state and are not removed by a repository update.

## Alternatives considered

**Keep both deployment launchers.** Rejected: every build, readiness, Tailscale, privilege, and cleanup change would continue to require two independent implementations and test paths.

**Deprecate the host launcher but leave it in the repository.** Rejected: an unmaintained installer that writes privileged system state is riskier than an explicit absence, and its continued presence implies support.

**Replace it with a smaller systemd template.** Rejected: unit rendering is not the difficult part; safe user selection, dependency preparation, operator ownership, Serve route ownership, readiness, and uninstall behavior would still need maintained code.

## Consequences

The repository no longer installs, manages, or uninstalls a persistent host-native Web service. A previously installed unit must be removed through that machine's systemd and Tailscale administration; deleting the checkout alone does not clean external state. Docker deployment and foreground `pnpm dsh web` remain available.

A host service may return only for a concrete host-native requirement that cannot be met through the container's explicit mounts and device access. Any replacement must preserve non-root agent execution, fail-closed operator and Serve route ownership, deterministic readiness and cleanup, and Fedora and Ubuntu validation.

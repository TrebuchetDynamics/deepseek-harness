# Agent Note: The Docker composition runs on podman and Fedora hosts unchanged

Status: implemented

English | [中文](2026-08-20-container-portability-podman-fedora.zh.md)

## Problem

The composition assumed a rootful Docker daemon on a Debian/Ubuntu-shaped host with one specific user. Three assumptions failed on Fedora and on any host whose user is not uid 1000:

- The launcher hard-required a `docker` executable and invoked it as `docker compose`. Fedora ships podman by default and many users run it rootless; the launcher refused to start even though podman runs the same Compose file.
- Fedora enables SELinux enforcing by default. Container processes run under the `container_t` label, which denies access to bind-mounted paths carrying user home labels — every mount in this composition (the whole home, the JDK, the Android SDK) would be unreadable.
- The image and entrypoint hardcoded uid 1000 (`setpriv --reuid=1000 --regid=1000 --init-groups`, build-time `chown -R 1000:1000`). Under rootless podman the default user namespace maps container uid 1000 to an unrelated subuid, so files the agent created in the mounted home would not belong to the invoking user on the host; and any host whose user is not uid 1000 got a process that could not write its own home.

## Decision

Runtime detection replaces the `docker` hard requirement. In the default `DSH_CONTAINER_RUNTIME=auto` mode, Docker wins only when it is not a podman compatibility shim, its Compose plugin is available, and `docker info` can reach the engine; otherwise the launcher tries a reachable podman engine with `podman compose`, falling back to the `podman-compose` provider. `DSH_CONTAINER_RUNTIME=docker|podman` selects one explicitly and fails with the rejected candidate's reason. The detected command array is used for every Compose invocation. The launcher fails early on non-Linux hosts and requires `node`, `curl`, `tailscale`, `flock`, and `readlink` on `PATH`; its host networking, process lock, and GNU path handling are Linux-specific. Tailscale command and JSON failures produce dedicated errors rather than empty MagicDNS follow-on failures.

The container process drops to the uid/gid that owns the mounted host home (`stat -c '%u %g'`, falling back to the invoking user with a warning when `stat` is unavailable), exported as `DSH_UID`/`DSH_GID` and passed through Compose to the entrypoint. The entrypoint defaults them to 1000 for standalone `docker run`, chowns the Tailscale state directories to them before starting `tailscaled`, and drops privileges with `setpriv --clear-groups` instead of `--init-groups`, because an arbitrary uid has no passwd entry in the image.

SELinux is handled once in the base compose file: both services set `security_opt: [label=disable]`. The alternative — `:z` relabeling on the mounts — would rewrite security labels on every file of the mounted home directory on the host; disabling the label for these two machine-local services is the safe direction. Docker accepts `label=disable` as a no-op on non-SELinux hosts, so the base file stays runtime-neutral.

Under rootless podman only, the launcher's generated per-launch override adds `userns_mode: keep-id` to the `dsh` service: the user namespace maps the invoking uid 1:1, so `DSH_UID` in the container is the same uid on the host. Rootless detection reads `podman info --format '{{.Host.Security.Rootless}}'`. `keep-id` is a podman-only value that the Docker daemon rejects at run time, which is why it reaches Compose only through the generated override, never the base file. Rootful podman and Docker use host uids directly and need no mapping.

The `dsh` service also sets `init: true`: the entrypoint execs away its shell, so orphaned children (the `pnpm`/`tsx` process tree, `tailscaled`) would otherwise accumulate as zombies; docker-init and podman's catatonit both reap them.

Dockerfile improvements in the same change: an npm cache mount (`--mount=type=cache,target=/root/.npm`) keeps the ~90 MB global-install download across rebuilds without entering the image layer (the old `rm -rf ~/.npm` would have wiped the cache mount and was dropped), OCI annotations (`org.opencontainers.image.*`, version from `DSH_VERSION`) make the built image inspectable, and the `VOLUME` declarations were removed — Compose owns state via the `tsstate` named volume, and anonymous volumes silently accumulated on every standalone relaunch. The launcher uses ordinary cached builds by default; `DSH_BUILD_NO_CACHE=1` opts into a clean rebuild while retaining the npm cache mount.

## Alternatives considered

**Document "install Docker" for Fedora users.** Rejected: rootless podman is the Fedora default and satisfies every need of this composition (host networking shares the host network namespace rootless, unprivileged ports, bind mounts); forcing a Docker daemon installation works against the system-agnostic stance.

**Handle SELinux with `:z`/`:Z` mount flags.** Rejected: the composition mounts the user's entire home read-write; `:z` relabels every file on the host to `container_file_t`, corrupting the user's SELinux policy expectations outside the container, and `:Z` is wrong for a two-service shared mount.

**Run as a fixed container user and remap at the mount.** Rejected: no mount-time uid remap exists for bind mounts; ownership is decided by the writing process, so the process itself must run as the host user's uid.

**Put `userns_mode: keep-id` in the base compose file.** Rejected: Docker's daemon rejects the value at container start; the setting can only reach podman runs, so it belongs in the podman-detected override.

**Apply `keep-id` to the `auth-proxy` service too.** Rejected: Caddy reads one read-only Caddyfile and binds an unprivileged loopback port; it writes nothing, so its uid mapping is irrelevant.

## Consequences

A Fedora host runs `./run-docker.sh` with rootless podman and no configuration: the launcher picks `podman compose`, generates the `keep-id` override, both services run with SELinux labels disabled, and the agent's files in the mounted home belong to the invoking user. Rootful Docker and rootful podman behavior is unchanged except for `init: true` (zombie reaping) and the uid now following the home's owner rather than the image's hardcoded 1000 — on the original machine both are uid 1000, so the observable difference is the chown and `--clear-groups` mechanics, not the resulting ownership.

Trade-offs: `podman compose` requires a provider binary and (for the `docker-compose` provider) a running `podman.socket` — the README's Fedora notes give the three setup commands; `restart: unless-stopped` under rootless podman only survives logout with `loginctl enable-linger`, also documented. Auto-selection rejects a `podman-docker` compatibility shim as Docker and selects the real podman engine, preserving rootless detection; an explicit runtime override remains available for ambiguous installations. `label=disable` removes SELinux confinement for these two services — acceptable because the services are machine-local, loopback-bound, and already hold read-write access to the home by design; the confinement they lose is not one the composition relied on. Standalone `docker run` (no Compose) no longer persists Tailscale state via an anonymous volume; Compose runs keep it via `tsstate`.

Verification uses out-of-repo stub hosts for rootless and rootful podman, provider absence, Docker engine failure with podman fallback, `podman-docker` shim detection, explicit runtime selection, cached and clean builds, orphan removal, startup diagnostics, port validation, missing `stat`, and no runtime. Entrypoint and Dockerfile checks pin the uid-agnostic `setpriv` drop, chown-before-`tailscaled` ordering, and label/cache/VOLUME decisions. Real Compose v5.5.0 rendering covers `init`, `security_opt`, `DSH_UID`/`DSH_GID` interpolation, and the `userns_mode` merge (absent from the base render, present with the rootless override).

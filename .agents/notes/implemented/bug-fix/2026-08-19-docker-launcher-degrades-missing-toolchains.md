# Agent Note: The Docker launcher degrades missing host toolchains instead of failing

Status: implemented

English | [中文](2026-08-19-docker-launcher-degrades-missing-toolchains.zh.md)

## Problem

`run-docker.sh` hard-required three machine-specific host layouts: Android platform tools at exactly `/usr/lib/android-sdk`, a `flutter` and a `java` executable on `PATH`, and repositories under `$HOME/git`. A host without the distro Android SDK package — for example a machine that keeps the SDK under `~/Android/Sdk` or has no Android toolchain at all — aborted at startup with `error: Android SDK not found under /usr/lib/android-sdk`, even though `adb` is optional for serving the GUI and editing non-Android repositories. The same fragility ran deeper: the script invoked Docker only as `/usr/bin/docker` (failing on hosts where it lives elsewhere, such as `/usr/local/bin/docker`), and `docker-compose.yml` hard-baked `/usr/lib/android-sdk`, `$HOME/git`, and a sdkman JDK path into its environment and bind mounts, so a Compose `up` on a differently laid-out host either failed or mounted nonexistent paths (letting the Docker daemon create empty root-owned directories at them).

The toolchains are conveniences for the mounted agent, not preconditions for serving the harness GUI; treating them as preconditions made the launcher single-machine instead of system-agnostic.

## Decision

`run-docker.sh` distinguishes hard prerequisites from optional toolchains. Hard prerequisites — a container runtime (Docker, or podman with a compose provider; see the 2026-08-20 portability note), `node`, `curl`, `tailscale` on `PATH`, an existing host home, an existing repository, and a checkout that is installed and built (see the 2026-08-20 checkout preflight note) — still abort with `error:` messages. Everything else degrades with `warning:` messages and a one-line `host toolchains:` summary:

- Flutter and Java are derived from `PATH` when present; absence or an invalid explicit override empties the variable.
- The Android SDK is discovered from `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, `~/Android/Sdk`, `~/android-sdk`, `/usr/lib/android-sdk`, `/opt/android-sdk` — first candidate with `platform-tools/adb` wins. `DSH_HOST_ANDROID_HOME` set to a path without `platform-tools/adb` warns and continues without the SDK.
- `$HOME/git` missing falls back to `$HOME` as the workspace.
- Docker is resolved through `command -v docker`, not a hardcoded path (a later note generalized this to docker-or-podman runtime detection).

An empty toolchain variable propagates as an empty Compose value: the base `docker-compose.yml` interpolates `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `JAVA_HOME`, `FLUTTER_ROOT`, `DSH_WORKSPACE`, and `PATH` from the launcher's discovery (nested `${VAR:-…}` defaults cover the absent case), and `dsh-entrypoint.sh` already guards every symlink with `-x`, so an absent toolchain simply produces no `flutter`/`adb`/`java` in the container.

Optional bind mounts moved out of the base compose file into a per-launch override file the script generates in a `mktemp -d` directory (removed on exit): JDK read-only, plus the Android SDK, out-of-home Flutter, out-of-home repository, `/run/udev`, and `/dev/bus/usb`, each only when it exists on the host. Compose cannot express a conditional bind mount, and a mount of a missing path makes the daemon create an empty root-owned directory, so "mount if present" must be a generated file. The base file keeps only the two mounts every host provides: the home directory and the `tsstate` volume. A direct `docker compose up` (own-node mode) therefore mounts only the home — the README documents this.

## Alternatives considered

**Keep hard requirements and document the supported layout.** Rejected: the harness GUI does not need `adb` to serve, and the launcher exists to run the container on the machines its users actually have, not on one curated distribution.

**Warn on a missing SDK but still fail when the workspace layout differs.** Rejected: `$HOME/git` is a convention of one primary user; any existing directory works as the agent workspace, so failure buys nothing.

**Express optional mounts with Compose profiles or `${VAR:?}` guards.** Rejected: profiles select services, not individual bind mounts, and no interpolation feature can conditionally emit a volume entry; a generated override file is the only mechanism Compose itself offers.

**Fall back to in-image SDK installation when the host has none.** Rejected: it would silently diverge from the host toolchains the container is meant to share (device builds against host `adb`, host JDK read-only), bloat the image, and need network access at build time.

## Consequences

The launcher now starts on hosts with any subset of the toolchains: a machine with only Flutter and Java (the reported case) launches with a single warning and no Android mounts, and a bare server without any toolchain or `~/git` still serves the GUI. On the original fully-equipped machine, behavior is unchanged — same environment values, same mounts including `/usr/lib/android-sdk` and the read-only JDK — verified by a stub-host suite (eight host scenarios spanning SDK-in-home, distro-only, ambient `ANDROID_HOME`, valid and invalid explicit overrides, bare host, plus a real-toolchain smoke run) and by `docker compose config` against the real Compose v5.5.0 binary confirming the nested-default interpolation and the base+override volume union with `:ro` preserved. The suite later grew to cover podman runtime detection and uid/gid mapping (see the 2026-08-20 portability note).

The trade-offs: a user who expects `adb` in the container must read the `host toolchains:` line to notice its absence (the warning names every checked location), and own-node Compose invocations no longer get toolchain mounts for free — they must add them or use `run-docker.sh`. Toolchain discovery remains a shell heuristic: a host whose SDK lives outside the candidate list must set `DSH_HOST_ANDROID_HOME` explicitly, and an invalid explicit override is skipped with a warning rather than failing, because it names a convenience, not a precondition.

The verification harness lives outside the repository (stub `docker`/`tailscale`/`curl` binaries plus sed-patched probe paths), since the repo's vitest suites cover packages, not host shell scripts; reintroducing a hardcoded host path in the launcher would not fail any in-repo gate.

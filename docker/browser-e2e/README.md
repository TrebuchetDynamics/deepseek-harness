# Reproducible browser e2e (Docker)

English | [中文](README.zh.md)

The [real-browser web e2e lane](../../apps/web/tests/README.md) (`pnpm run
test:web`) drives real Chromium through the assembled web chain. It needs a
working Chromium renderer plus the OS libraries a stock Playwright Chromium
depends on. A contributor environment — typically a no-root devcontainer — can
have neither, which blocks the lane entirely even though the rest of the repo
tests fine.

`docker/browser-e2e` is the Phase 1 answer: a reproducible container image that
ships the exact Chromium build the repository's lockfile resolves plus its
system libraries, so the lane runs anywhere Docker exists. It mirrors the
approach the hosted CI consumer job already uses (`.github/workflows/ci.yml`,
"Install Playwright Chromium and hosted dependencies") and is itself exercised
by a dedicated CI job (`.github/workflows/browser-e2e-docker.yml`).

## Files

| Path                     | Purpose                                                                  |
| ------------------------ | ------------------------------------------------------------------------ |
| `Dockerfile`             | Toolchain image: node 24 + pnpm + lockfile Chromium + OS deps (setuid sandbox) |
| `run.sh`                 | Build the image and run `test:web` against the current checkout          |
| `README.md`              | This file                                                               |

## How it works

- The image does **not** embed a checkout. The `run` script and the CI job bind
  the repository read-write at `/workspace` and run `pnpm install
  --frozen-lockfile && pnpm run test:web` there. Browser bytes and OS deps are
  provisioned once into a `pnpm-lock.yaml`-keyed build layer; the workspace
  install happens per run from the mounted (current) checkout.
- Chromium lives at `/opt/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`); its OS
  libraries are installed at build time by `playwright install --with-deps`.
- The image installs setuid Chromium and Bubblewrap helpers. The container runs
  as the caller uid; the full lane requires `--privileged` because its product
  tests create nested filesystem sandboxes.
- The wrapper mounts the caller's pnpm store at the same absolute path so repeated runs reuse downloads without making host `node_modules` point at a container-only store.

## Run

```sh
docker/browser-e2e/run.sh --privileged
```

This builds the image (first build is slow — it provisions Chromium), then runs
the lane keylessly in replay mode. The default command is:

```sh
pnpm install --frozen-lockfile && pnpm run test:web
```

Every env passthrough and the `DSH_SNAPSHOT` default come from `run.sh`; see its
help (`docker/browser-e2e/run.sh --help`).

### Modes

`DSH_SNAPSHOT` selects the lane mode, exactly as it does outside Docker:

- `replay` (default) — keyless; compares against committed goldens.
- `record` — drives the live model; needs `DEEPSEEK_API_KEY` (and optionally
  `DEEPSEEK_BASE_URL`), both passed through by `run.sh`.
- `refresh` — rewrites committed aria goldens keylessly.

CI never runs `record` or `refresh`; it forces `replay` (see the
[browser-snapshot CI gate](../../.agents/notes/implemented/testing/2026-07-30-web-browser-snapshot-ci-gate.md)).

## Container privileges and networking

The full lane creates nested product sandboxes, so its default command refuses
to start without the explicit `--privileged` flag. Custom smoke commands remain
unprivileged unless requested. The container keeps Docker bridge networking;
`--host-network` separately allows scenarios to reach host-only services.

## CI

`.github/workflows/browser-e2e-docker.yml` builds the image (with the
GitHub-hosted layer cache) and runs the lane keylessly in a privileged container
after trusted-branch pushes, on schedule, or by explicit dispatch. Pull requests
continue to use the native browser gate. It is the
canary for the reproducible-Docker runtime itself: broken Dockerfile, a drifted
Playwright/Chromium pair, or a missing OS dep fails there first. It complements,
does not replace, the native browser-snapshot gate in `ci.yml`.

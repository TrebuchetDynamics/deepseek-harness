# DeepSeek Harness in Docker, served over Tailscale

A personal-fork utility: run the DeepSeek Harness Web GUI (`dsh web`) from a
container and expose it over a Tailscale tailnet. These files are additive to
the upstream repo and never change product code, which is what lets the fork
stay in sync with upstream with trivial conflicts.

## Why loopback + Tailscale

`dsh web` deliberately binds `127.0.0.1` only and refuses `--host 0.0.0.0`
(binding all interfaces would expose remote code execution to the network). The
image keeps that guarantee: `tailscaled` runs inside the same container and
`tailscale serve` proxies the tailnet :443 (MagicDNS TLS) to
`http://127.0.0.1:3080`. The browser is only ever on the encrypted tailnet;
nothing is published to the host or the public internet.

The /api transport has a browser-trust fence (DNS-rebinding and cross-site
defense). The entrypoint passes the serving hostname to `dsh --trusted-host`,
so the fence accepts requests whose Host is the tailnet name. The fence is not
an auth layer: your tailnet ACLs remain the access control for the GUI.

## The configuration plane stays loopback

Settings and credential RPCs (`settings.*`, `credentials.*`,
`llm.discoverModels`, agent-preset management) are pinned to loopback even on a
trusted-host deployment. So you configure the container through the environment,
not the GUI: `DEEPSEEK_API_KEY` (and optionally `DEEPSEEK_BASE_URL`) are read by
the LLM provider at request time. Everything a session does over the GUI — chat,
tools, files, subagents — works over the tailnet.

## Files

| Path | Purpose |
| --- | --- |
| `../Dockerfile` | Slim runtime image; installs the published `@deepseek-ai/dsh` CLI (`DSH_VERSION` ARG) |
| `dsh-entrypoint.sh` | Join the tailnet (when a key is set), serve :443, then run `dsh web` as uid 9000 |
| `docker-compose.yml` | Reference compose wiring an API key, a tailnet key, and volumes |
| `../.dockerignore` | Keeps the build context lean |

## Build

```sh
docker build -t dsh-tailscale:local -f Dockerfile .
```

The image installs the published `@deepseek-ai/dsh` CLI and its workspace peers
(web app, built frontend `dist/`, native addons) from npm, so it builds in
minutes and stays small. `DSH_VERSION` (ARG, default `0.1.0-rc.7`) pins the
release; bump it together with the fork's upstream sync. A source-built
monorepo image is possible but not provided by default — it compiles the whole
repository.

## Run as its own tailnet node (needs an auth key)

Get a Tailscale auth key from the admin console and a DeepSeek API key:

```sh
export DEEPSEEK_API_KEY=sk-...
export TS_AUTHKEY=tskey-auth-...
export TS_HOSTNAME=dsh          # the tailnet machine name (optional)
docker compose -f docker/docker-compose.yml up -d --build
```

The served URL appears in the logs (`docker compose logs -f dsh`). Open
`https://dsh.your-tailnet.ts.net/` from any tailnet device. Your tailnet node
identity persists in the `tsstate` volume, so only the first start needs
`TS_AUTHKEY`.

## Run using your PC's existing Tailscale node (no auth key)

If the host machine is already a tailnet node (the common case), the container
can share its network stack and you expose the app with the host's own
`tailscale serve`. No container-side auth key is needed: the app still binds
loopback only, and your existing node name serves it.

```sh
# 1. run the container on the host network, on a free loopback port
docker run -d --name dsh-ts --network host \
  -e DSH_PORT=3137 \
  -e DSH_TRUSTED_HOSTS=<your-node>.<your-tailnet>.ts.net \
  -e DEEPSEEK_API_KEY=sk-... \
  -v dsh-home:/dsh-home -v workspace:/workspace \
  dsh-tailscale:local

# 2. on the HOST, allow your user to manage serve, then forward :443 to that port
sudo tailscale set --operator=$USER        # once; makes 'tailscale serve' work without root
tailscale serve --bg --https=443 http://127.0.0.1:3137

# 3. open the harness from any tailnet device
#    https://<your-node>.<your-tailnet>.ts.net/
```

`DSH_TRUSTED_HOSTS` carries the MagicDNS name the fence must accept (the
own-node mode above derives it automatically from the node's own tailscaled).

## Run without Tailscale (localhost only)

```sh
docker run --rm -p 127.0.0.1:3080:3080 \
  -e DEEPSEEK_API_KEY=sk-... -v dsh-home:/dsh-home -v workspace:/workspace \
  dsh-tailscale:local
```

With no `TS_AUTHKEY` the container skips Tailscale. Note the app binds
`127.0.0.1` *inside* the container, so a published port only works when both
sides use loopback; publishing to a non-loopback host address will not reach it
— that is the point. To read the UI from inside the container use
`docker exec <c> curl http://127.0.0.1:3080/`.

## Environment reference

| Variable | Default | Meaning |
| --- | --- | --- |
| `TS_AUTHKEY` | *(unset)* | Tailscale auth key; unset disables the tailnet entirely |
| `TS_HOSTNAME` | container id | Tailscale machine name |
| `TS_EXTRA_ARGS` | *(empty)* | Extra `tailscale up` args (e.g. `--advertise-tags=tag:dsh`) |
| `TS_USERSPACE` | `1` | `1` = userspace networking (no NET_ADMIN, no /dev/net/tun); `0` = kernel tun when available |
| `DSH_PORT` | `3080` | Web UI listen port (also the `tailscale serve` target) |
| `DSH_WORKSPACE` | `/workspace` | Agent working directory |
| `DSH_TRUSTED_HOSTS` | *(empty)* | Extra /api authorities (space/comma separated) appended to the derived tailnet name |
| `DEEPSEEK_API_KEY` | *(empty)* | LLM credential read by the provider (required to do anything) |
| `DEEPSEEK_BASE_URL` | *(empty)* | Optional DeepSeek-compatible base URL |

## Keeping the fork up to date with upstream

The upstream project is the second remote (`upstream`):

```sh
git remote -v
#   origin    https://github.com/<you>/deepseek-harness.git   (this fork)
#   upstream  https://github.com/deepseek-ai/deepseek-harness.git
```

To pull upstream and rebase the fork's utilities on top:

```sh
git fetch upstream
git rebase upstream/master     # or: git merge upstream/master
git push --force-with-lease origin master
```

Utility files are additive to paths upstream does not touch (`docker/`,
`Dockerfile`, `.dockerignore`), so the rebase stays near-conflict-free.

## Known limitations

- The configuration plane is loopback-only by design: set keys and settings
  through the environment. This is upstream `dsh web` behavior, not a regression.
- The image runs the published `dsh` packages at `DSH_VERSION`, not a
  source-built monorepo; fork-only product changes would require the
  source-build variant.
- `tailscale serve` needs MagicDNS-enabled HTTPS-capable tailnet names (the
  default `*.ts.net` names qualify automatically).

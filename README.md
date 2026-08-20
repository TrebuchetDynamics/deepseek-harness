# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

### Run the Web UI as a host service (`run-web.sh`)

On a Tailscale-connected Fedora or Ubuntu host, [run-web.sh](run-web.sh) installs a systemd service that runs the source checkout as your non-root user, starts at boot, restarts after failures, and publishes the UI over HTTP via the tailnet IP and HTTPS via MagicDNS:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
./run-web.sh
```

The installer enables the repository's pinned pnpm through Corepack when needed, installs dependencies, builds all artifacts, requests `sudo` for the system unit, enables `tailscaled`, grants your account the Tailscale operator role, verifies readiness, and leaves the DSH process itself unprivileged. Run `./run-web.sh status`, `logs`, `restart`, `stop`, or `uninstall` to manage it. Service ports and the startup timeout live in `/etc/dsh-web.env`; restart the service after editing that root-owned file. `./run-web.sh run` keeps a foreground, non-persistent mode for diagnostics.

The service owns its configured Tailscale Serve ports and removes those routes when it stops. Installation refuses to replace another Tailscale operator or pre-existing Serve routes on the same ports. Tailnet access is controlled by Tailscale policy; trusted-host validation is not user authentication.

### Run the Web UI in Docker (`run-docker.sh`)

For a containerized deployment, [run-docker.sh](run-docker.sh) builds the image and runs the Web UI behind a loopback Tailscale-identity proxy, publishing it as `https://<host>.<tailnet>.ts.net/`. See [docker/README.md](docker/README.md).

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

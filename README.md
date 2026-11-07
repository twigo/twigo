<h1 align="center">Twigo</h1>

<p align="center"><b>A desktop IDE for Kubernetes — fast, keyboard-first, and open source.</b></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/twigo/.github/main/profile/images/workbench-dark.webp">
    <img src="https://raw.githubusercontent.com/twigo/.github/main/profile/images/workbench-light.webp" alt="Twigo with the deployments of a cluster, the logs of a three-pod deployment and the logs of a crashing pod side by side">
  </picture>
</p>

Twigo opens the clusters in your kubeconfig and shows what needs attention first: the pods that fail, why they fail in plain words, and the logs of the container that crashed.
It reads the kubeconfig kubectl already uses, so contexts never live in two places.
A native app built with Rust and Tauri, with no account and no telemetry.

## Status

Twigo is in early development and has no release yet, so you build it from source.
Reading clusters works today: lists of every kind, custom resources included; overviews that put problems first; logs of a whole workload; sign-in through exec plugins and OIDC.
Editing with a dry-run diff, exec, port-forward, Helm and an MCP server for AI agents come next.
The first beta ships for macOS and Linux, and Windows follows right after.
It supports Kubernetes 1.33 and later.

## Build from source

You need Rust through rustup, pnpm 12, and on Linux the [Tauri system libraries](https://v2.tauri.app/start/prerequisites/#linux).

```bash
pnpm install
pnpm tauri dev
```

## Learn more

- [Contributing](CONTRIBUTING.md): the setup and the checks before a pull request.
- [Architecture](docs/ARCHITECTURE.md): the design and the decisions behind it.
- [Performance budgets](docs/bench.md): what is measured at 5,000 pods, and the latest results.
- [Security policy](SECURITY.md): how to report a vulnerability.

## License

[Apache-2.0](LICENSE).

# Twigo

[![CI](https://github.com/twigo/twigo/actions/workflows/ci.yml/badge.svg)](https://github.com/twigo/twigo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A desktop IDE for [NATS](https://nats.io) - connect to a server and work with
it like an IDE, the way Lens does for Kubernetes.

## Why

Existing NATS GUIs are functional but the experience is dated. Twigo aims to be
the tool you actually enjoy using: a fast, keyboard-first, well-designed client
that imports your existing `nats` CLI contexts and gets out of your way.

## Features

- Imports your existing `nats` CLI contexts (`~/.config/nats/context/`), with a
  configurable directory and an opt-in public demo server (`demo.nats.io`)
- Connect / disconnect with live status; creds, token, user/password, nkey, and
  TLS (CA, client certificate, handshake-first); read-only contexts
- Subject explorer with live message rates
- Live subscriptions, publish, and request/reply
- Message viewer (JSON / text / hex) with message-to-message diff
- JetStream: streams & consumers, plus a message browser
- KV store browser with revision history
- Object store browser
- Server monitoring overview (varz / connz / jsz)
- Command palette, native menu, light & dark themes

## Install

Download the latest build for your platform from the
[Releases page](https://github.com/twigo/twigo/releases/latest):

- **macOS** - `.dmg` (Apple silicon and Intel)
- **Linux** - `.AppImage` or `.deb`

Windows is not packaged yet. On Linux the builds are currently unsigned.

## Building from source

Prerequisites: [Node.js](https://nodejs.org) + [pnpm](https://pnpm.io),
[Rust](https://rustup.rs), and (for a local server) [Docker](https://docker.com).

```bash
pnpm install
docker compose up -d   # local NATS with JetStream (:4222) + monitoring (:8222)
pnpm tauri dev         # run the app
pnpm tauri build       # produce a release bundle
```

To generate continuous fake traffic for testing the subject explorer:

```bash
docker compose --profile traffic up -d   # publishes to telemetry.*, orders.*, …
```

## Stack

[Tauri 2](https://tauri.app) · React + TypeScript · [async-nats](https://github.com/nats-io/nats.rs)
· Tailwind CSS + shadcn/ui

## Contributing

Contributions are welcome - see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Serhii Mazurok

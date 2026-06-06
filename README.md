# Twigo

A desktop IDE for [NATS](https://nats.io) — connect to a server and work with
it like an IDE, the way Lens does for Kubernetes.

> **Status: early / work in progress.** Core connection management works;
> messaging, JetStream, KV and Object Store are on the roadmap below.

## Why

Existing NATS GUIs are functional but the experience is dated. Twigo aims to be
the tool you actually enjoy using: a fast, keyboard-first, well-designed client
that imports your existing `nats` CLI contexts and gets out of your way.

## Features

**Working today**
- Imports your existing `nats` CLI contexts (`~/.config/nats/context/`), with a
  configurable contexts directory
- Connect / disconnect with live status (creds, token, user/password, or nkey)
- Light & dark themes

**Roadmap**
- Subject explorer with live message rates
- Live subscriptions, publish & request/reply
- Message viewer (JSON / hex / …)
- JetStream (streams & consumers), KV and Object Store browsers
- Server monitoring overview
- Command palette, request collections

## Stack

[Tauri 2](https://tauri.app) · React + TypeScript · [async-nats](https://github.com/nats-io/nats.rs)
· Tailwind CSS + shadcn/ui

## Getting started

Prerequisites: [Node.js](https://nodejs.org) + [pnpm](https://pnpm.io),
[Rust](https://rustup.rs), and (for a local server) [Docker](https://docker.com).

```bash
pnpm install
docker compose up -d   # local NATS with JetStream (:4222) + monitoring (:8222)
pnpm tauri dev         # run the app
```

To package a release build:

```bash
pnpm tauri build
```

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Serhii Mazurok

# Contributing to Twigo

Thanks for your interest in improving Twigo!

## Development setup

See the [README](README.md#building-from-source) for prerequisites and how to
run the app. In short:

```bash
pnpm install
docker compose up -d
pnpm tauri dev
```

## Before opening a PR

```bash
pnpm typecheck      # TypeScript
pnpm lint           # ESLint
pnpm format:check   # Prettier (use `pnpm format` to auto-fix)
pnpm test           # frontend tests
cargo fmt    --manifest-path apps/twigo/src-tauri/Cargo.toml --check
cargo clippy --manifest-path apps/twigo/src-tauri/Cargo.toml -- -D warnings
cargo test   --manifest-path apps/twigo/src-tauri/Cargo.toml
```

CI runs the same checks on every pull request.

## Conventions

- **Comments are minimal** - explain non-obvious _why_, not _what_.
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `chore:`, `docs:`, `style:`, `refactor:`, `test:`).
- **Accessibility**: interactive elements must be keyboard-reachable and
  labeled; prefer real semantic elements over click handlers on `<div>`.
- Match the style of the surrounding code.

## Workflow

1. Branch off `main` (`feat/...`, `fix/...`).
2. Keep PRs focused; describe what and why.
3. PRs are squash-merged into `main`.

# Contributing to Twigo

Thanks for your interest in improving Twigo!

## Development setup

You need:

- Rust through rustup: `rust-toolchain.toml` pins the version;
- pnpm 12 (`packageManager` in `package.json`).
  It downloads the Node.js version that `devEngines.runtime` pins and runs every script with it;
- on Linux, the [Tauri system libraries](https://v2.tauri.app/start/prerequisites/#linux).

```bash
pnpm install
pnpm tauri dev
```

## Before opening a PR

```bash
pnpm format:check   # Prettier (use `pnpm format` to fix)
pnpm typecheck      # TypeScript
pnpm lint           # ESLint, including the package boundaries
pnpm test           # frontend tests
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

CI runs the same checks on every pull request; the Rust checks skip a change to Markdown alone.

## Conventions

- **Correct code, no workarounds**: fix the cause; a temporary measure needs the maintainer's approval and an `@todo` at the site.
  Keep code modular, easy to extend and no more complex than the problem.
  Leave nothing your change made obsolete, and bring what it touches into line with these rules ([decision](docs/decisions/code-quality.md)).
- **Comments are minimal**: explain a non-obvious _why_, not _what_.
- **Evidence**: a claim about a library or upstream behaviour cites the source at a tag, and every number names the run that produced it ([decision](docs/decisions/evidence.md)).
- **Markdown** has one sentence per line, with no breaks inside a sentence ([decision](docs/decisions/markdown-lines.md)).
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org), with the types that `pr-title.yml` accepts ([decision](docs/decisions/branch-names.md)).
- **Accessibility**: interactive elements must be keyboard-reachable and labelled; prefer real semantic elements over click handlers on `<div>`.
- Match the style of the surrounding code.

## Workflow

1. Branch off `main` as `<type>/<topic>`, where the type is the Conventional Commit type of the PR title: `feat/space-tabs`, `fix/drag-region`, `build/bump-tauri` ([decision](docs/decisions/branch-names.md)).
2. Keep PRs focused; describe what and why.
3. PRs are squash-merged into `main`.

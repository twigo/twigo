<!-- Use a Conventional Commit title, e.g. feat(jetstream): add consumer view -->

## What

<!-- What does this PR change, and why? -->

## How to test

<!-- Steps to verify the change. -->

## Checklist

- [ ] Conventional Commit PR title (feat / fix / docs / refactor / chore / …)
- [ ] `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` pass
- [ ] `cargo fmt --check && cargo clippy -- -D warnings && cargo test` pass (if backend changed)
- [ ] Tests added or updated
- [ ] No `any`, no silent `catch`, no throwaway hacks
- [ ] Interactive UI is keyboard-accessible

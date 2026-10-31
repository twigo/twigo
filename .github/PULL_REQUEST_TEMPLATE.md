<!-- Use a Conventional Commit title, e.g. feat(kube): add the pod log view -->

## What

<!-- What does this PR change, and why? -->

## How to test

<!-- Steps to verify the change. -->

## Checklist

- [ ] Conventional Commit PR title (feat / fix / docs / refactor / chore / …)
- [ ] `pnpm format:check && pnpm typecheck && pnpm lint && pnpm test` pass
- [ ] `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` pass
- [ ] Tests added or updated
- [ ] No `any`, no silent `catch`, no throwaway hacks
- [ ] Interactive UI is keyboard-accessible

# Branches are named `<type>/<topic>` after the Conventional Commit type of their PR

Decided 2026-10-31.

## Decision

- A branch is named `<type>/<topic>`: `feat/scaffold`, `fix/drag-region`,
  `chore/bump-tauri`.
- `<type>` is the type of the PR title, one of the Conventional Commit types
  that `pr-title.yml` accepts: `feat`, `fix`, `docs`, `style`, `refactor`,
  `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- `<topic>` is a few lowercase words joined by hyphens.

## Why

The PR title becomes the squash-merge subject on `main`, and git-cliff groups
the changelog by its type. A branch that carries the same type shows what a PR
is before it is opened, and the list of branches reads like the changelog to
come.

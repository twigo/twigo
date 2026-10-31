# Code

- Write the correct solution, never a workaround: no hacks, no shims around a fixable bug, no silenced errors, warnings or lints ([decision](../../docs/decisions/code-quality.md)).
- A temporary measure needs the owner's OK first.
  Mark it at the site with an `@todo: <what to remove> once <what it waits for>` comment.
- Follow `docs/ARCHITECTURE.md`: crate and package boundaries (2.2, 2.3), no domain logic in `apps/desktop`.
  If the code proves the document wrong, change the document in the same PR.
- Keep modules small and single-purpose, with a narrow public API.
  Prefer types that make invalid states unrepresentable.
- Make extension a matter of data and registries: a new kind, column, command or view should not need edits all over the code.
- Do not overengineer: no abstraction for one caller, no option nobody asked for, no handling for cases that cannot happen.
  Validate at the boundary; trust internal invariants.
- Leave nothing legacy.
  If a change makes code, tests, docs or config obsolete, remove or update them in the same PR.
  If something the change touches breaks these rules, bring it into line in the same PR, as its own commit.

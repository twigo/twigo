# Code is the correct solution, modular and as simple as the problem allows

Decided 2026-10-31.

## Decision

- **No workarounds.**
  Code fixes the cause instead of working around it: no hacks, no shims around a bug that can be fixed, no silenced errors, warnings or lints.
- **A temporary measure is the exception.**
  When one is unavoidable, such as an upstream bug or a missing API, it needs the owner's approval.
  It is marked at the site with an `@todo` comment that says what to remove and what it waits for.
- **Architecture first.**
  Code follows [ARCHITECTURE.md](../ARCHITECTURE.md):
  - the crates and packages of 2.2 and 2.3 and their dependency directions;
  - domain logic stays out of `apps/desktop`;
  - when the code shows the document is wrong, the same PR changes the document.
- **Modular and easy to extend.**
  - One responsibility per module, and a small public API.
  - Types that make invalid states unrepresentable.
  - New kinds, columns, commands and views plug in through registries and data, not through edits scattered across the code.
- **No overengineering.**
  - No abstraction for a single caller, and no option nobody asked for.
  - No handling for cases that cannot happen.
    A case that can happen is handled; one that cannot is not written.
  - Inputs from outside are validated at the boundary, and the code inside trusts its own invariants.
- **Nothing is left legacy.**
  - When a change makes code, tests, docs or config obsolete, the same PR removes or updates them.
  - Anything the change touches that breaks these rules is brought into line in the same PR, as its own commit.
  - The codebase stays in one style, not in layers of old and new.

## Why

Twigo is open source and will outlive any one change.
A workaround is untested behaviour that the next change has to discover.
An abstraction or an edge case that never occurs is code everyone reads and nobody needs.
Old code left next to new code teaches the next contributor the wrong pattern.

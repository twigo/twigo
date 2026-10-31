# Claims are backed by sources read and runs made

Decided 2026-10-31.

## Decision

- A statement about a library, an API, a CLI or upstream behaviour rests on its source or docs, read for the change at the version in use.
- Upstream code is cited at a tag or a commit, never at a moving branch.
- What was not checked is marked as such in place, and an unsupported claim is withdrawn rather than guessed.
- Every number names the run that produced it.
- A check counts as evidence only if it has been seen to fail, or plainly could.

## Why

The HTTP/2 and Table spikes each carried claims that read well and were wrong:

- a grep for a log line the cluster never writes, offered as proof that no watch was closed;
- an explanation for a short event window that the method could not support;
- metrics servers said to lack Table support, when the library they are built on requires it.

Each was caught only by a reviewer who read the source.
Writing the source down first is cheaper than finding the gap later.

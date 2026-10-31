# Evidence

- A claim about a library, an API, a CLI or upstream behaviour comes from its source or docs read in this session ([decision](../../docs/decisions/evidence.md)).
  Read the code at the version in use: `~/.cargo/registry/src/*/<crate>-<version>`, `node_modules`, or the upstream repository at a tag, or the docs through Context7.
- Cite upstream code as a link at a tag or a commit, never at `master` or `main`, and check that the lines still match.
- What you could not check, say in place: "not verified", "not measured".
  Never fill a gap with a plausible guess, and retract a claim you cannot back.
- Every number in a doc or a PR names the run that produced it: the command, the cluster or fixture, and the date.
- A check that cannot fail is no evidence.
  Before trusting a test, a grep or a metric, see it fail once on purpose, or show why it would.
- Report what ran and what it printed, not that it passes.

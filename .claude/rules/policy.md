---
paths:
  - "crates/twigo-policy/**"
  - "crates/twigo-kube/src/client/**"
  - "crates/twigo-core/**"
---

# The gate

- A new way to change a cluster adds its row to the table in `crates/twigo-policy/tests/gate.rs`: the request, its class, and each mode's answer ([decision](../../docs/decisions/policy-gate.md)).
- A test that says a thing was blocked proves it by what the server saw.
- What the classifier cannot read as harmless is the stricter class.
- A test or tool writes only to `kind-*` and `kwok-*` contexts, and `Gate::unrestricted()` is only for those.

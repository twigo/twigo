---
paths:
  - "crates/twigo-helm/**"
  - "crates/twigo-policy/src/redact/**"
---

# Helm releases

- A release's values, the chart's defaults, its manifest, its hooks' manifests, its notes and its revisions' descriptions stay in `twigo_policy::redact::Held` from the decode until a mask, a scrub or a Reveal of one place gives them out ([decision](../../docs/decisions/helm-release-masking.md)).
  Never give `Held` a `Serialize`, a `Debug` that prints its value, or an accessor outside `redact`.
- An error says where, never what: a category, a line and a column, and the Secret's type; never the `Display` or `Debug` of a serde, serde-saphyr or base64 error, which quote the input, and never a value in a message, a log, an assertion's text or a panic.
- `packages/protocol/src/mock/helm.json` and `helm-revealed.json` are written by `TWIGO_UPDATE_HELM=1 cargo test -p twigo-helm --test mock`, never by hand; a change to what the decoder or a masker gives runs it again.

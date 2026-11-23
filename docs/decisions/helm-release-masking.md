# A Helm release's secret-grade parts leave Rust masked, scrubbed or one place at a time

Decided 2026-11-22 with the owner (ARCHITECTURE 3.6, 6.4).

## Context

A release Secret holds a whole release: the person's values, the chart's defaults, the rendered manifest with its Secrets in clear, the hooks' manifests, the rendered NOTES.txt and a description of each revision.
Values often carry credentials: argo-cd 10.18.2 renders a cluster's credentials from `configs.clusterCredentials` into a Secret ([cluster-secrets.yaml](https://github.com/argoproj/argo-helm/blob/argo-cd-10.18.2/charts/argo-cd/templates/argocd-configs/cluster-secrets.yaml#L20-L37)), and Harbor 1.19.4's defaults ship `harborAdminPassword: "Harbor12345"` ([values.yaml](https://github.com/goharbor/harbor-helm/blob/v1.19.4/values.yaml#L288)), live until someone overrides it.
Notes can print a password ([osTicket-helm](https://github.com/mike-matera/osTicket-helm/blob/43a9c71cdb3bce1b53061a73c6677cdd639e65a8/charts/osticket/templates/NOTES.txt#L24-L29)), and a failed upgrade's description quotes the API server's refusal, which for a Secret that does not convert quotes the patched object, its values with it (recorded on kind 1.37 with Helm v4.3.2 on 2026-11-22, `crates/twigo-helm/tests/fixtures/record-failed.sh`).
Helm, k9s, Freelens, Headlamp and Rancher show values and manifests in clear; Argo CD masks the Secrets of manifests and diffs ([application.go](https://github.com/argoproj/argo-cd/blob/v3.6.2/server/application/application.go#L635-L650)), and Flux masks a Secret's drift as changed or not ([mask.go](https://github.com/fluxcd/pkg/blob/ssa/v0.83.0/ssa/jsondiff/mask.go#L25-L40)).

## Decision

- **Values: every string and number masked.**
  Keys, booleans and nulls stay as stored, and every string and number reads `<N bytes>`, the chart's defaults as the person's values; a Reveal shows any leaf, any subtree or the whole document.
- **Notes and descriptions: scrubbed, not hidden.**
  Each value of the revision's Secrets, the manifest's and the hooks', is taken out where it stands as a whole token, as the apply preview scrubs a refusal, and each patched object a refusal quotes goes whole; a Reveal shows the whole text.
- **A comparison: changed or not.**
  Rust compares the real values, and a masked value that differs from its counterpart reads `<N bytes, changed>` on both sides; values pair by path, a manifest's Secrets by namespace and name, a Secret whose document writes no namespace in its release's.
- **The manifest: its Secrets only.**
  Every `kind: Secret`, at a document's root or inside `items` at any depth, is masked as an open Secret is, and every other document goes as it stands.
- **Held in Rust until a Reveal.**
  The decoded page holds each secret-grade part in `twigo_policy::redact::Held`, which has no `Serialize` and prints only its size, and gives it out only through the maskers or a Reveal of one place.

## Why

- Masking by key names or value patterns lets through every secret under a name no list holds, as argo-cd's credentials under `config` or an `env` item's `value` beside `name: DB_PASSWORD`, and every chosen password, as the `changeit` of Harbor's defaults ([values.yaml](https://github.com/goharbor/harbor-helm/blob/v1.19.4/values.yaml#L1089)); it would also mask what names a Secret, as Harbor's `existingSecretAdminPassword` ([values.yaml](https://github.com/goharbor/harbor-helm/blob/v1.19.4/values.yaml#L286)).
  Numbers stay masked, since YAML reads an unquoted numeric password as a number.
  Booleans and nulls carry no secret, and the keys give the release's shape at a glance, so a Reveal can be as small as the one setting a person needs.
- Hiding the notes would put a chart's instructions behind a dialog for every release, while scrubbing hides the passwords that the release's own Secrets hold, osTicket's case, and the patched Secret a refusal quotes, without hiding the host names and commands that make notes useful.
  Scrubbing by every value of the values would hide those host names too.
- A comparison of masked texts hides every change that keeps a size, which Compare with… says of Secrets today; changed-or-not tells the truth and gives away only that a value changed, as Argo CD and Flux do.
  A hash per value would tell equal values apart across releases and contexts, and an unsalted hash of a password like `changeit` falls to a dictionary.
- A value can reach any object, not only a Secret, but Twigo shows a ConfigMap's values and a container's literal environment in clear on their own pages, so masking them in a manifest would hide nothing the cluster's objects do not show; masking Secrets only keeps the rule of open objects.
  A Secret is found by parsing every document, never by a search of the text, since `kind: "\x53ecret"` is a Secret to a YAML reader and to no substring search.
- A type that cannot be serialized makes a part that reaches IPC unmasked fail to compile, where a test would only catch the cases it has.

## Consequences

- Reading a release's values costs a Reveal for each setting the person wants to read, a dialog outside `read-write` (6.4).
- A masked document shows key names, list lengths, which scalars are booleans or nulls, and sizes; a comparison shows which values changed.
- A value of a Secret that the notes also print elsewhere in another spelling, or a value of the values that is no Secret's, stays in the notes.
- A value of a Secret with no letter or digit, such as `/` or a space, is never taken out of a text, as it cannot be told from the punctuation and the spaces around it: it stays in the notes, the descriptions and the words of a refusal.
- The mock's releases are written from the decoder's own output by `twigo-helm`'s `mock` test, which checks that they hold no value of a Secret, in clear or as base64.

## Where it is implemented

- `crates/twigo-policy/src/redact/`: `Held`, the values masker, the manifest masker, the comparison, the scrubbing and the Reveals.
- `crates/twigo-helm/src/page.rs`: the page that holds a revision's parts and gives them out.

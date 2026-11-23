# A Helm release's secret-grade parts leave Rust masked, scrubbed or through a Reveal

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
  Each value of the revision's Secrets, the manifest's and the hooks', of four characters or more, is taken out where it stands as a whole token, as the apply preview scrubs a refusal, and each patched object a refusal quotes goes whole; a Reveal shows the whole text.
- **A comparison: changed or not.**
  Rust compares the real values, and a masked value that differs from its counterpart reads `<N bytes, changed>` on both sides; values pair by path, a manifest's Secrets by namespace and name, a Secret whose document writes no namespace, or an empty one, in its release's.
- **The manifest: its Secrets only.**
  Every `kind: Secret`, at a document's root or inside `items` at any depth, is masked as an open Secret is, and every other document goes as it stands.
  A Reveal shows one key of one Secret, one document Twigo could not read, or the whole manifest as `helm get manifest` prints it, every Secret and unread document at once, behind one confirmation.
- **Held in Rust until a Reveal.**
  The decoded page holds each secret-grade part in `twigo_policy::redact::Held`, which has no `Serialize` and prints only its size, and gives it out only through the maskers or a Reveal.

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
- A value of the values that is no Secret's stays in the notes, and so does a value of a Secret that the notes print in a spelling Twigo does not take out.
  A number, and a Secret's text that reads whole as a JSON number, is taken out as stored, as Go's `%v` prints it as a float64, which is how Helm's templates print a value read from YAML, as Go's `encoding/json` writes it, which `toJson` prints, and as its integer digits where it is whole.
  No other spelling is: a `printf` of its own verb or precision, such as `%.2f` or `%x`, a number that `| int` cut where it was not whole, digits padded or led by zeros, a number that stands inside a longer value of the Secret, such as a port in a URL, and any text a template makes of a value, such as `| upper` or `| b64enc` of a part of it.
- A value of a Secret shorter than four characters, such as `0`, `1`, `on` or the text `1.0`, and any spelling of a number that short, such as the `1` Go prints for `1.0`, is never taken out of a text, as it cannot be told from the numbers and the words around it and hides no secret worth the garbling: taken out, a Secret's `0` would turn the default notes of `helm create`'s chart, rendered by helm v4.3.2 for a ClusterIP Service, into `{.items[<hidden>].metadata.name}` and `http://127.<hidden>.<hidden>.1:8080`, which give the value back and no longer run.
  It stays in the notes, the descriptions, an edit's refusal and its preview's warnings, a password or a PIN of three characters among them; its base64, as `MQ==` for `1`, is long enough and still goes.
- A value of a Secret with no letter or digit, such as `----` or spaces, is never taken out of a text either, as it cannot be told from the punctuation and the spaces around it.
- The mock's releases are written from the decoder's own output by `twigo-helm`'s `mock` test, which checks that they hold no value of a Secret, in clear or as base64.

## Where it is implemented

- `crates/twigo-policy/src/redact/`: `Held`, the values masker, the manifest masker, the comparison, the scrubbing and the Reveals.
- `crates/twigo-helm/src/page.rs`: the page that holds a revision's parts and gives them out.

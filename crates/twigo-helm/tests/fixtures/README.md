# Helm release fixtures

Release Secrets and one ConfigMap as the API server answered `kubectl get <kind> <name> -n <namespace> -o json`, and what helm printed for them.
They are recorded server responses: never reformat or edit them by hand.
Names are `<namespace>.<object name>.json`.

Every release comes from a chart written for these fixtures (`charts/`), so nothing in it is private; its passwords are fixture strings.

## Written by helm

Recorded on 2026-11-22 from a kind cluster of `bench/cluster.sh up <name> 1.37` (Kubernetes v1.37.0 node image), with helm v4.3.2 and v3.22.1 from get.helm.sh, checked against their published checksums.
Every helm process ran with `TZ=UTC` but `delta`'s, and every call named the cluster with `--kubeconfig` and `--kube-context`.

| File | How |
| --- | --- |
| `secrets/fmt-a.sh.helm.release.v1.alpha.v1.json`, `.v2.json` | helm v4.3.2: `install alpha charts/demo -n fmt-a -f charts/alpha-r1.yaml --set replicaCount=2 --labels team=fixtures`, then `upgrade alpha charts/demo -n fmt-a -f charts/alpha-r2.yaml`. Chart `demo` (apiVersion v2) has a subchart with `import-values`, globals, a schema, two files, a hook, a test hook and NOTES.txt, and its manifest holds a Secret. Revision 1 is `superseded`, 2 `deployed`; both carry `apply_method: ssa` and the custom label `team=fixtures`. |
| `secrets/fmt-b.sh.helm.release.v1.beta.v1.json`, `.v2.json` | helm v3.22.1: `install beta charts/plain -n fmt-b --set message=hi-from-v3`, `upgrade beta charts/plain -n fmt-b --set message=second`, `uninstall beta -n fmt-b --keep-history`. Chart `plain` is apiVersion v1 with no NOTES.txt. Revision 2 is `uninstalled`; helm v3 writes `"deleted":""` where nothing was deleted. |
| `secrets/fmt-b.sh.helm.release.v1.alpha.v1.json` | helm v4.3.2: `install alpha charts/plain -n fmt-b`, a second release named `alpha` in another namespace. |
| `secrets/fmt-c.sh.helm.release.v1.delta.v1.json` | helm v4.3.2 with `TZ=Asia/Tokyo`: `install delta charts/plain -n fmt-c`. Its times end in `+09:00`; it has no user values, so its release has no `config`. |
| `secrets/fmt-c.sh.helm.release.v1.order.v1.json` | helm v4.3.2: `install order charts/plain -n fmt-c -f charts/order.yaml`, keys whose byte order and go-yaml's order differ, and YAML 1.1 words that helm stored as booleans. |
| `configmaps/fmt-c.sh.helm.release.v1.gamma.v1.json` | helm v4.3.2 with `HELM_DRIVER=configmap`: `install gamma charts/plain -n fmt-c --set message=in-a-configmap`, then `upgrade gamma charts/plain -n fmt-c --set message=second`. Its `data.release` is Helm's base64 string itself, one base64 layer fewer than a Secret's. |
| `secrets/fmt-a.sh.helm.release.v1.epsilon.v1.json`, `.v2.json` | helm v4.3.2, by `record-failed.sh` beside this file, on 2026-11-22: `install epsilon charts/failing -n fmt-a --server-side=false --set password=epsilon-password-r1`, then `upgrade epsilon charts/failing -n fmt-a --set password=epsilon-password-r2 --set 'extra=not base64!'`, which the API server refused with the patched Secret quoted. Revision 1 stays `deployed`, 2 is `failed`, and its description quotes the Secret's values; its notes print the password. |

## Crafted

Each is a Secret built from the ones above, created on the cluster with `kubectl create -f` and read back.
A crafted Secret carries the labels `owner=helm`, `name`, `status`, `version` and `modifiedAt=1795000000`, and its release is the JSON of the release named, renamed, gzipped at the best compression with no name and mtime 0, as Go's writer does, and base64-encoded, unless the row says otherwise.

| File | What it is | What helm v4.3.2 does with it |
| --- | --- | --- |
| `secrets/fmt-store.sh.helm.release.v1.alpha.v2.json` | `alpha`'s revision 2 copied into `fmt-store`, its release still saying `namespace: fmt-a`, as Flux's `storageNamespace` keeps a release away from its `targetNamespace`. | `list -n fmt-store` shows it with NAMESPACE `fmt-a`. |
| `secrets/fmt-d.sh.helm.release.v1.trunc.v1.json` | `alpha`'s revision 2, its gzip stream cut in half. | `list` skips it; `history` prints an empty table; `get values --revision 1` says `unexpected EOF`. |
| `secrets/fmt-d.sh.helm.release.v1.badb64.v1.json` | `H4sI!!not-base64!!` in place of Helm's base64. | The same, with `illegal base64 data at input byte 4`. |
| `secrets/fmt-d.sh.helm.release.v1.badjson.v1.json` | The gzip of `{"name":5}`. | The same, with Go's error that a number does not fit `Release.name`. |
| `secrets/fmt-d.sh.helm.release.v1.nokey.v1.json` | The labels, and the key `other` in place of `release`. | The same, with `unexpected end of JSON input`. |
| `secrets/fmt-d.sh.helm.release.v1.nogzip.v1.json` | `beta`'s revision 1, base64 of its JSON with no gzip. | Read as any other: helm inflates only where the bytes start with `1f 8b 08`. |
| `secrets/fmt-d.sh.helm.release.v1.future.v1.json` | `beta`'s revision 1 in a Secret of type `helm.sh/release.v2`. | Read as any other: helm never reads the type. |
| `secrets/fmt-d.sh.helm.release.v1.mismatch.v1.json` | `beta`'s revision 1, its status label `deployed` and its release `failed`. | `list` and `history` print `failed`. |
| `secrets/fmt-d.sh.helm.release.v1.stuck.v1.json`, `.v2.json` | `beta`'s revision 1 `deployed`, and a revision 2 left `pending-upgrade` with `last_deployed` `2026-11-22T20:20:00Z`, as a helm killed mid-upgrade leaves it. | `upgrade` says `another operation (install/upgrade/rollback) is in progress`. |

## What helm printed

`get/` holds what helm v4.3.2 printed for each revision of `alpha` in `fmt-a` and of `beta`, `get manifest`, `get notes`, `get hooks`, `get values -o json` and `get metadata -o json`, in `<release>.r<revision>.v4.<part>`, `history -o json` of both in `<release>.v4.history.json`, and `get values -o json` of `order` in `order.r1.v4.values.json`.
helm v3.22.1 printed the same bytes for those revisions' manifests, notes, hooks and values.
`record-failed.sh` writes `epsilon`'s manifests, notes and history beside them.

`get manifest` prints the stored manifest and a line feed; `get notes` prints `NOTES:`, a line feed, the stored notes and a line feed, or nothing for none; `get hooks` prints, for each hook, `---`, a `# Source:` line with its path, its stored manifest and a line feed.

## Left out

A release at 99 % of Kubernetes' 1 MiB limit and a release behind 64 MiB of JSON white space are not recorded here: `tests/big.rs` builds a release near the limit and a gzip bomb as it runs.

# Spike: the Table decoder

M0 step 2, 2026-10-31. The question: what do Table lists and watches really
send, and what does a decoded row cost?

- Decoder: `crates/twigo-cache/src/table.rs`, requests in `table/request.rs`.
- Tests: `tests/table_fixtures.rs` on recorded responses and synthetic
  fallbacks; `tests/table_live.rs` against kind, run per release by
  `bench/test-matrix.sh` and `.github/workflows/kubernetes.yml`.
- Memory: `examples/table_memory.rs`.
- Clusters: `bench/cluster.sh` (kind with kwok and its fake nodes, an explicit
  kubeconfig) and `bench/pods.sh` (N pods on the fake nodes).

## What the server sends

Checked against the apiserver source at v1.37.0 unless a release is named,
and against kind clusters from 1.32 to 1.37.

1. **Column definitions come once per response.** The watch encoder sets
   `NoHeaders` after the first object it encodes
   ([response.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/response.go#L81-L97)).
   - Every list page carries them, with `continue` and `remainingItemCount`.
   - A watch carries them in its first event, whatever its type. On a quiet
     collection that is a BOOKMARK, and the ADDED events after it come
     without definitions.
   - A new connection sends them again. The decoder keeps them per upstream
     and keeps the same allocation when they have not changed.
2. **One row per watch event; a BOOKMARK is a Table too.** Its single row has
   placeholder cells (`""`, `"0/0"`, `"<unknown>"`, `"<none>"` for a Pod),
   and its object holds only `resourceVersion`, plus
   `k8s.io/initial-events-end` at the end of a streaming list. The decoder
   turns it into `Event::Bookmark`, never a row.
3. **`row.object` keeps managedFields.** It is a `PartialObjectMetadata`
   ([asTable](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/response.go#L367-L413)),
   and every recorded list and watch includes managedFields. The row struct
   names neither managedFields nor annotation values, so serde skips them
   without allocating.
4. **A failed conversion sends the raw object** (`result = obj` in the same
   function), and `NoHeaders` flips anyway: when the first event of a
   connection fails, that connection never sends definitions. A raw object
   becomes a row with Name and Age and empty other cells. A Table row that
   arrives with no definitions known returns `DecodeError::NoColumns`, and
   the hub is expected to reconnect.
5. **Cells follow their JSON type.** ConfigMap `Data` is declared `string`
   and sent as an integer; Pod `Restarts` is a string such as `"0"`. The
   decoder types cells by their JSON value.
6. **Age.**
   - Built-in printers name it Age and describe it with creationTimestamp's
     field doc, as type `string`.
   - A CRD without printer columns gets the same column as type `date`.
   - A CRD's own Age column is a printer column on
     `.metadata.creationTimestamp`, described by its JSONPath.
   - The decoder recognises all three and stores `Cell::Age`, which the UI
     renders from `meta.created`.
   - The default table convertor's `Created At` column is an absolute
     RFC 3339 time
     ([table.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/registry/rest/table.go#L82-L83))
     and stays text.
7. **CRD `date` columns** are rendered as a duration when encoded, "303d"
   ([tableconvertor.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiextensions-apiserver/pkg/registry/customresource/tableconvertor/tableconvertor.go#L177-L185)).
   They stay text and change only with the next modify event. Missing
   JSONPath values are `null` cells.
8. **Priority.** Pods put IP, Node, Nominated Node and Readiness Gates at
   priority 1; CRD printer columns carry their own.
9. **Streaming lists (`sendInitialEvents=true`) depend on the release.**
   - **1.32:** the WatchList gate is on, but the list handler refuses the
     Table transform for streaming lists
     ([get.go](https://github.com/kubernetes/kubernetes/blob/v1.32.11/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/get.go#L208-L211),
     [L332-L341](https://github.com/kubernetes/kubernetes/blob/v1.32.11/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/get.go#L332-L341)).
     The `application/json` fallback then serves raw full objects, with
     managedFields. Worse, every watch from `resourceVersion` "" or "0" with
     bookmarks is defaulted into a streaming list
     ([defaults.go](https://github.com/kubernetes/kubernetes/blob/v1.32.11/staging/src/k8s.io/apimachinery/pkg/apis/meta/internalversion/defaults.go#L25-L38)),
     so a plain Table watch from 0 gets raw objects too, for the whole
     connection.
   - **1.33:** the gate is off, and the server rejects `sendInitialEvents`.
   - **1.34 to 1.37:** the restriction is gone. The initial objects arrive as
     Table ADDED events, then the annotated bookmark.
   - So a Table upstream streams only on 1.34 and later. Elsewhere it lists
     in pages and watches from the exact `resourceVersion` of the list.
10. **Aggregated APIs without Table** answer the same Accept header through
    its JSON fallback with raw lists and objects. They get the metadata
    columns, Name and Age. This path is covered by a fixture
    (`metrics-list.json`, `metrics-watch.jsonl`), not by a live server.

## Tests

`bench/test-matrix.sh` on 2026-10-31, kind 0.33.0, the three live tests per
release:

| Kubernetes | Node image                          | Live tests |
| ---------- | ----------------------------------- | ---------- |
| 1.32       | `kindest/node:v1.32.11` (kind 0.31) | passed     |
| 1.33       | `kindest/node:v1.33.12` (kind 0.32) | passed     |
| 1.34       | `kindest/node:v1.34.11`             | passed     |
| 1.35       | `kindest/node:v1.35.8`              | passed     |
| 1.36       | `kindest/node:v1.36.4`              | passed     |
| 1.37       | `kindest/node:v1.37.0`              | passed     |

- `pods_list_and_watch`: column names, priorities and Age; a list, then a
  watch that sees definitions only in its first event; a reconnect that
  receives them again and keeps the decoder's allocation.
- `streaming_lists_depend_on_the_release`: point 9, per release.
- `crd_printer_columns`: string, integer, number, boolean, date and Age
  printer columns, priority 1, and `null` cells.

The fixture tests cover what a live cluster cannot produce on demand: a
connection that starts with a bookmark, a raw object after a failed
conversion, an aggregated API without Table, a `410 Gone` status, and rows
that arrive before any definitions.

## Memory

`examples/table_memory.rs`, release build, on kind 1.37 with 5,000 kwok pods
of one Deployment: two labels and one owner reference each. The Table
responses are 9.9 MiB in ten pages of 500. A dhat counting allocator measures
requested bytes retained after decoding:

| Representation                                 | 5,000 pods | Per pod  |
| ---------------------------------------------- | ---------- | -------- |
| Full Pod                                       | 137.0 MiB  | 28,736 B |
| Pod without managedFields                      | 84.7 MiB   | 17,764 B |
| `PartialObjectMeta<Pod>`                       | 59.8 MiB   | 12,532 B |
| `PartialObjectMeta<Pod>` without managedFields | 7.4 MiB    | 1,560 B  |
| Table row (`twigo_cache::table::Row`)          | 3.4 MiB    | 704 B    |

- A row costs half of a `PartialObjectMeta<Pod>` without managedFields: it
  keeps meta-lite and the cells, and none of the other metadata.
- Decoding the 5,000 rows allocated 12.7 MiB in all, little more than the
  responses themselves.
- The numbers that 3.3 quoted before this spike came from synthetic 7.4 KB
  Pods, so their absolute values differ; the order is the same.

## Changes to the architecture

- 3.2, initial list: streaming lists for Table upstreams on 1.34 and later
  only, with the 1.32 behaviour of point 9.
- 3.3: the decoder bullets follow points 1 to 7 and 10; the metadata
  fallback is Name and Age, since the namespace comes from meta-lite for
  every kind; the memory table is the one above.

## Reproducing

```bash
export TWIGO_BENCH_DIR=$(mktemp -d)
bench/test-matrix.sh                     # every release, or e.g. 1.32 1.37
kubeconfig=$(bench/cluster.sh up mem 1.37 | tail -1)
bench/pods.sh "$kubeconfig" 5000
TWIGO_TEST_KUBECONFIG=$kubeconfig \
  cargo run --release -p twigo-cache --example table_memory
bench/cluster.sh down mem
```

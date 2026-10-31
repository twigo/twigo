# Spike: the Table decoder

M0 step 2, 2026-10-31.
The question: what do Table lists and watches really send, and what does a decoded row cost?

- Decoder: `crates/twigo-cache/src/table.rs`, requests in `table/request.rs`.
- Tests: `tests/table_fixtures.rs` on recorded responses and synthetic fallbacks; `tests/table_live.rs` against kind, run per release by `bench/test-matrix.sh` and `.github/workflows/kubernetes.yml`.
- Memory: `examples/table_memory.rs`.
- Clusters: `bench/cluster.sh` (kind with kwok and its fake nodes, an explicit kubeconfig) and `bench/pods.sh` (N pods on the fake nodes).

## What the server sends

Checked against the apiserver source at v1.37.0 unless a release is named, and against kind clusters from 1.33 to 1.37.

1. **Column definitions come once per response.**
   The watch encoder sets `NoHeaders` after the first object it encodes ([response.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/response.go#L81-L97)).
   - Every list page carries them, with `continue` and `remainingItemCount`.
   - A watch carries them in its first event, whatever its type.
     On a quiet collection that is a BOOKMARK, and the ADDED events after it come without definitions.
   - A new connection sends them again.
     The decoder keeps them per upstream and keeps the same allocation when they have not changed.
2. **One row per watch event; a BOOKMARK is a Table too.**
   Its single row has placeholder cells (`""`, `"0/0"`, `"<unknown>"`, `"<none>"` for a Pod), and its object holds only `resourceVersion`, plus `k8s.io/initial-events-end` at the end of a streaming list.
   The decoder turns it into `Event::Bookmark`, never a row.
3. **`row.object` keeps managedFields.**
   It is a `PartialObjectMetadata` ([asTable](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/response.go#L367-L413)), and every recorded list and watch includes managedFields.
   The row struct names neither managedFields nor annotation values, so serde skips them without allocating.
4. **A failed conversion sends the raw object** ([`result = obj`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/response.go#L82-L86)), and `NoHeaders` flips anyway: when the first event of a connection fails, that connection never sends definitions.
   A raw object becomes a row with Name and Age and empty other cells.
   A Table row that arrives with no definitions known returns `DecodeError::NoColumns`, and the hub is expected to reconnect.
5. **Cells follow their JSON type.**
   ConfigMap `Data` is declared `string` and sent as an integer; Pod `Restarts` is a string such as `"0"`.
   The decoder types cells by their JSON value.
6. **Age.**
   - Built-in printers name it Age and describe it with creationTimestamp's field doc, as type `string`.
   - A CRD without printer columns gets the same column as type `date`.
   - A CRD's own Age column is a printer column on `.metadata.creationTimestamp`, described by its JSONPath.
   - The decoder recognises all three and stores `Cell::Age`, which the UI renders from `meta.created`.
   - The default table convertor's `Created At` column is an absolute RFC 3339 time ([table.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/registry/rest/table.go#L54-L57)) and stays text.
7. **CRD `date` columns** are rendered as a duration when encoded, "303d" ([tableconvertor.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiextensions-apiserver/pkg/registry/customresource/tableconvertor/tableconvertor.go#L177-L185)).
   They stay text and change only with the next modify event.
   Missing JSONPath values are `null` cells.
8. **Priority.**
   Pods put IP, Node, Nominated Node and Readiness Gates at priority 1; CRD printer columns carry their own.
9. **Streaming lists (`sendInitialEvents=true`) depend on the release.**
   - **Defaulting.**
     Wherever the WatchList gate is on, the server turns a watch from `resourceVersion` "" or "0" into a streaming list ([defaults.go](https://github.com/kubernetes/kubernetes/blob/v1.32.11/staging/src/k8s.io/apimachinery/pkg/apis/meta/internalversion/defaults.go#L25-L38), called at [get.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/get.go#L216) in 1.37 too).
     The hub therefore watches from an exact `resourceVersion` or asks for initial events explicitly.
   - **1.32**, no longer supported (D12): a streaming list that also asks for bookmarks is refused the Table transform ([get.go](https://github.com/kubernetes/kubernetes/blob/v1.32.11/staging/src/k8s.io/apiserver/pkg/endpoints/handlers/get.go#L332-L341)), and the JSON fallback serves raw full objects.
   - **1.33:** the gate is off, and the server rejects `sendInitialEvents` with 422.
   - **1.34 to 1.37:** the initial objects arrive as Table ADDED events, then the annotated bookmark.
   - So a Table upstream streams on 1.34 and later.
     On 1.33 it lists in pages and watches from the exact `resourceVersion` of the list.
10. **Every `k8s.io/apiserver` server implements Table.**
    Its installer refuses a lister without a TableConvertor ([installer.go](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apiserver/pkg/endpoints/installer.go#L483-L487)), and metrics-server implements one ([pod.go](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.1/pkg/api/pod.go#L141-L158)).
    A server built otherwise may ignore `as=Table`; the Accept header's `application/json` fallback then brings raw lists and objects, which get the metadata columns, Name and Age (fixtures `raw-list.json`, `raw-watch.jsonl`).
11. **Rows may lack a uid and a resourceVersion.**
    ComponentStatus objects carry only a name (recorded in `componentstatuses-list.json`), and metrics-server builds its metrics from name, namespace, labels and creationTimestamp ([pod.go](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.1/pkg/storage/pod.go#L86-L91)).
    `Meta::uid` is optional; the row store keys such rows by namespace and name.
12. **An empty Table may send `rows: null`.**
    Go encodes a nil slice as `null`, and the default table convertor and metrics-server leave `Rows` nil for an empty collection; metrics-server then sends no column definitions either ([table.go](https://github.com/kubernetes-sigs/metrics-server/blob/v0.9.1/pkg/api/table.go#L26-L74)).
    The decoder reads `null` as empty wherever Go may write it.

## Tests

`bench/test-matrix.sh` on 2026-10-31, kind 0.33.0, the three live tests per release:

| Kubernetes | Node image                          | Live tests |
| ---------- | ----------------------------------- | ---------- |
| 1.33       | `kindest/node:v1.33.12` (kind 0.32) | passed     |
| 1.34       | `kindest/node:v1.34.11`             | passed     |
| 1.35       | `kindest/node:v1.35.8`              | passed     |
| 1.36       | `kindest/node:v1.36.4`              | passed     |
| 1.37       | `kindest/node:v1.37.0`              | passed     |

- `pods_list_and_watch`: column names, priorities and Age; a list, then a watch that sees definitions only in its first event; a reconnect that receives them again and keeps the decoder's allocation.
- `streaming_lists_depend_on_the_release`: point 9, per release.
- `crd_printer_columns`: string, integer, number, boolean, date and Age printer columns, priority 1, and `null` cells.

The fixture tests cover what a live cluster cannot produce on demand:

- a connection that starts with a bookmark;
- a raw object after a failed conversion, and a server without Table;
- metrics-server's Table, ComponentStatus rows without a uid, and an empty Table with `rows: null`;
- an integral value in a `number` column, an `AGE` date column;
- wrong cell and row counts, a bookmark without a `resourceVersion`, a `410 Gone` status, and rows that arrive before any definitions.

## Memory

`examples/table_memory.rs`, release build, on kind 1.37 with 5,000 kwok pods of one Deployment: two labels and one owner reference each.
The Table responses are 9.9 MiB in ten pages of 500.
A dhat counting allocator measures requested bytes retained after decoding:

| Representation                                 | 5,000 pods | Per pod  |
| ---------------------------------------------- | ---------- | -------- |
| Full Pod                                       | 137.0 MiB  | 28,736 B |
| Pod without managedFields                      | 84.7 MiB   | 17,764 B |
| `PartialObjectMeta<Pod>`                       | 59.8 MiB   | 12,532 B |
| `PartialObjectMeta<Pod>` without managedFields | 7.4 MiB    | 1,560 B  |
| Table row (`twigo_cache::table::Row`)          | 3.4 MiB    | 704 B    |

- A row costs half of a `PartialObjectMeta<Pod>` without managedFields: it keeps meta-lite and the cells, and none of the other metadata.
- Decoding the 5,000 rows allocated 12.7 MiB in all, little more than the responses themselves.
- A second run after the review fixes gave the same rows, and object representations within 0.2 MiB of these.
- Three runs on 2026-10-31 with the HTTP/2 `api` client of `Clients`, which the example now uses, gave the same rows and the same 12.7 MiB, and object representations within 0.3 MiB of these.
- The numbers that 3.3 quoted before this spike came from synthetic 7.4 KB Pods, so their absolute values differ; the order is the same.

## Changes to the architecture

- D12: Twigo supports Kubernetes 1.33 and later.
  1.32 left upstream support on 2026-02-28.
- 3.2, initial list: streaming lists on 1.34 and later.
- 3.3: the decoder bullets follow points 1 to 7 and 10 to 12; the metadata fallback is Name and Age, since the namespace comes from meta-lite for every kind; the memory table is the one above.

## Reproducing

```bash
export TWIGO_BENCH_DIR=$(mktemp -d)
bench/test-matrix.sh                     # every release, or e.g. 1.33 1.37
kubeconfig=$(bench/cluster.sh up mem 1.37 | tail -1)
bench/pods.sh "$kubeconfig" 5000
TWIGO_TEST_KUBECONFIG=$kubeconfig \
  cargo run --release -p twigo-cache --example table_memory
bench/cluster.sh down mem
```

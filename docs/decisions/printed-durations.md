# A duration the server printed is drawn from the moment its row was stamped

Decided 2026-11-16 with the owner, the stamp's rule on 2026-11-17 (ARCHITECTURE 3.3, 3.4, 4.4).

## Context

The API server prints some cells as a duration, once, as it encodes the row: a pod's Restarts as `3 (5m ago)` from `time.Since` of the last container's finish ([`printPod`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/pkg/printers/internalversion/printers.go#L1110-L1113)), a CronJob's Last Schedule, an event's Last Seen and First Seen, and a custom resource's `date` columns ([tableconvertor.go](https://github.com/kubernetes/apiextensions-apiserver/blob/v0.37.2/pkg/registry/customresource/tableconvertor/tableconvertor.go#L177-L184)).
Twigo keeps a row's cells until the object's next event, so that text stood still while the list stayed open, and a restart within the hour, which the list draws in the warning tone, stayed amber.
Lists ask for metadata only (3.3), so the times the text came from are not there, and whole objects would cost the memory the core's budget does not have.

## Decision

- Each stored row carries `received`, the time the core received its cells: a watch event as its line arrives, a list page as its response starts.
  It travels to the webview as `Row.received`, beside `created`.
- Which columns print a duration is the core's to say, once, and travels with the column as `printsDuration`:
  - the built-in printers' columns by resource and column (`table::PRINTED`), core and `events.k8s.io` events alike, since they share one storage and printer;
  - every `date` column;
  - never a column by its name alone, since a custom resource's string column holds whatever its JSONPath finds.
- The webview draws such a cell from the moment it stands for, `received` less the printed age, as an Age is drawn, on the page's one timer, and draws it again only when its text or its tone changes.
  A cell with no usable moment, a stamp that does not parse or a moment more than a second ahead of the clock, shows the text as printed.
- A row keeps its stamp while every printed duration in it can stand for the moment the held print stands for: it reads the same age, and less than that age's step in `HumanDuration` has passed, give or take 2 s ([duration.go](https://github.com/kubernetes/apimachinery/blob/v0.37.2/pkg/util/duration/duration.go#L48-L93)).
  Otherwise it takes the new stamp, and the view sends the row again.
- Such a column sorts by the moment it stands for, the latest first, and a pod's Restarts by its count, then that moment; the text filter reads no age in it, a pod's Restarts by its count and nothing of a cell that is only a duration.
- The mock backend follows the same rules from a copy of `table::PRINTED`, and shared cases hold both sides: `packages/protocol/src/printed-cases.json` for the stamp, `query-cases.json` for the sort and the filter.

## Why

The time a row's text was true is a fact the core has and the webview lacks, and it costs a stored row nothing: `Meta` stays 128 bytes and `Row` 144, held by const assertions, so an `Arc<Row>` asks for 160 bytes, a malloc class of its own on macOS 27.2, where 176 would take 192 (`malloc_size` after `malloc`, 2026-11-17).
On the wire a row grows by its `"received"`, 38 bytes of JSON, and a batch that carries the columns by 22 bytes for each column that prints a duration.

A stamp that moved whenever the row was printed again would count a new text back from an old print, or an old text from a new one: a pod printed again under the same restart age, by a relist or a change of its status, would draw its age backwards by the time between the two prints.
Keeping the stamp while the text can still stand for the same moment keeps the age on screen where it was and sends nothing, while an event that repeats 3 s or more apart, whose Last Seen reads `0s` at each repeat, takes each repeat's stamp.
The 2 s are the margin `HumanDuration` gives clocks out of step ([duration.go](https://github.com/kubernetes/apimachinery/blob/v0.37.2/pkg/util/duration/duration.go#L49-L54)); the latency from the server's print to the stamp was not measured.

The server rounds an age down to its step, so the moment drawn is never earlier than the true one, and an age reads younger than it is by less than its step: the warning of a restart within the hour can outlast the hour by under a minute and never ends early.

A sort by the age as printed would contradict the ages on screen as time passes; the moment does not move, so nothing is sorted again as the ages grow.
A person filters by what they read, and the age they read is not the printed one.

## Consequences

- A list page stamped once its body was whole, seconds later on a slow link, would count each age from a later moment than it was printed at, so the page is stamped as its response starts; what remains is the server's time from print to its first bytes, and the network's.
- The ticking cells cost CPU in a visible window: in the bench's visible phase they read about one point of one core more than the same build with them stopped (`TODO.md`).
- Printed durations outside the columns the core marks stay frozen text, as a running Job's Duration and an Overview's printer columns (`TODO.md`).
- The details draw the selected row's cells until its object comes (ARCHITECTURE 4.3): each column as the list draws it, `CellView`, so a printed duration counts from the row's stamp there too and the details and the row say the same age.
  A row printed `19 (2m46s ago)` and received 8 s ago reads `2m54s ago` in both (the `Details.test.tsx` test of the stand-in cells).
- An age in a part whose stages are decided by its width keeps the room of the widest age of its range (`widestDuration` in [`packages/utils/src/duration.ts`](../../packages/utils/src/duration.ts)), so that its ticking moves no stage; the header of an object's page does (the [decision](parts-give-way-by-width.md)).

## Where it is implemented

- The core: the printed text and the stamp's rule in [`crates/twigo-cache/src/printed.rs`](../../crates/twigo-cache/src/printed.rs), which columns print one in [`table.rs`](../../crates/twigo-cache/src/table.rs), the stamp kept in [`store.rs`](../../crates/twigo-cache/src/store.rs), taken in [`upstream.rs`](../../crates/twigo-cache/src/upstream.rs) and [`meta.rs`](../../crates/twigo-cache/src/meta.rs), sent again in [`view.rs`](../../crates/twigo-cache/src/view.rs), and sorted in [`view/sort.rs`](../../crates/twigo-cache/src/view/sort.rs).
- The wire: `Row.received` and `Column.printsDuration` in [`crates/twigo-ipc/src/list.rs`](../../crates/twigo-ipc/src/list.rs).
- The webview: `printedAt` and `printedAge` in [`packages/kube/src/age.ts`](../../packages/kube/src/age.ts), `Since` and `Restarts` in [`packages/kube/src/list/cells.tsx`](../../packages/kube/src/list/cells.tsx), which the details' stand-in cells in [`packages/kube/src/Details.tsx`](../../packages/kube/src/Details.tsx) draw their columns with, the column's `ticks` in [`columns.ts`](../../packages/kube/src/columns.ts), and `useNowAs` in [`useNow.ts`](../../packages/kube/src/useNow.ts).
- The mock: [`packages/protocol/src/mock/printed.ts`](../../packages/protocol/src/mock/printed.ts) and [`query.ts`](../../packages/protocol/src/mock/query.ts), with [`printed-cases.json`](../../packages/protocol/src/printed-cases.json).
- The rule [`.claude/rules/printed-durations.md`](../../.claude/rules/printed-durations.md) holds it for work in the core's cache, `packages/kube` and the mock.

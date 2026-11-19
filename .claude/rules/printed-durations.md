---
paths:
  - "crates/twigo-cache/**"
  - "packages/kube/**"
  - "packages/protocol/src/mock/**"
---

# Printed durations

- A duration the API server printed in a cell (`3 (5m ago)`, `5m`) is drawn from the moment it stands for, the row's `received` less the printed age, never as frozen text ([decision](../../docs/decisions/printed-durations.md)).
- Which columns print one is the core's to say, by resource and column (`table::PRINTED`) and for every `date` column, and travels as `Column.printsDuration`; the webview keeps no list of its own, the mock, standing in for the core, mirrors `table::PRINTED` in `packages/protocol/src/mock/printed.ts` and a change to one changes both, and nothing goes by a column's name alone.
- A row keeps its stamp while each of its printed durations can stand for the held moment (`printed::keeps_stamp`), and the view sends a row again when its stamp changed.
- Such a column sorts by its moment and is not filtered by its age; a cell whose text is no duration, as `<unknown>`, is drawn, sorted and filtered as text, and one with no usable stamp is drawn as printed.
- A cell that ticks draws again only when its text or its tone changes (`useNowAs`), on the page's one timer, never rendering its row or the grid.
- The details draw the selected row's cells through `CellView` until their object comes, never as the text the row holds.
- Rust and the mock decide alike: a change to the stamp, the sort or the filter adds a case to `packages/protocol/src/printed-cases.json` or `query-cases.json`, which both run.
- `Meta` and `Row` keep the sizes their const assertions hold: a new field is a decision about a stored row's malloc class.

# An object's page says each thing once, never folds a finding away, and holds still as the selection moves

Decided 2026-11-14 with the owner; the full page, with folds of its own, in one column, and one header on every view on 2026-11-18; the pill's tone where the list's rule calls its word healthy on 2026-11-19 (ARCHITECTURE 3.6, 4.3, 4.9, 5.1).

## Context

The page of an object, in the details beside a list and as an editor, answers the questions of a triage: is it wrong, which part, what happened, why there, how is it set up, what is it.
It was a column of open sections.
A section named after the kind held rows that other sections repeated, a pod's Phase and Ready among them, beside its Conditions and its Diagnostics, and every long value shared one label column with the short ones.
The inspector follows the selection, so a person holding ↓ in a list reads one fact change from pod to pod, and anything that moved under them was read as a change.

## Decision

- **The page says a thing once.**
  - A pod's phase and readiness are the pill and the vitals, not rows; its node, addresses, class and scheduling are in Placement, its volumes in Storage and its policies in Configuration; no section of a pod, a Deployment, a StatefulSet, a DaemonSet or a node is named after the kind, where a Job's, a CronJob's, a Service's, an Ingress's and a claim's first section is.
  - A condition is a chip, and says why in a line only where it is wrong and no finding explains it (`Condition.explained`).
  - A pod's usage is its vitals' CPU and Memory and a line on each container, never a section; a node's has one.
  - A sentence in the header is the first finding's title, else the vitals in words, and the pill's word is the list's own, so the page and the list never say two things.
- **A fold never hides a finding.**
  - A section that holds what is wrong carries its tone as an edge and a summary that names it, whether it is open or not.
  - One that holds a finding the Diagnostics section does not explain is `finding`, and opens over what the person last chose for the kind; they can still fold it, for the object they folded it in.
  - The full page keeps that rule, and the page's filter opens every section that has a match.
- **The header and the strip hold still while the selection moves along rows of one kind.**
  - Each line of the header that is drawn has a height of its own and the vitals strip a fixed height, whatever the object, the state of its usage or the stage a line is at.
  - Before the object comes the pill's word is the row's, and the strip's places are those of the last object of its kind that this header showed, as dashes.
    The held places cover that time only: once the object has come the cells are its own, so a Deployment has `Revision` only where it carries the annotation (`workloads.rs`), whatever the held places were.
    An object editor holds nothing, so it has no word, no strip and no third line before its first batch.
  - The third line is drawn where the object has a word of the list's health column, where its strip has cells, or where it has a sentence, and before the object comes where the row had a word, or the last object of its kind that this header showed had cells or a sentence (ARCHITECTURE 4.3).
    A kind with no health column and no vitals, a Job, a Service, an Ingress, a claim or a ConfigMap, has it only while the object has a sentence, which the core gives only with a finding, and the held line stands until the object comes and no longer.
  - A line that has to come later is drawn at its height with a stand-in, a dash or an empty meter, never left out.
  - Nothing is measured per row: a line reads hidden copies of its stages once per header, and a part's stage is a function of its room (the [decision](parts-give-way-by-width.md)).
- **Folds are kept per kind, and apart for the full page.**
  - What a person folds or opens is kept for the kind, never for the object, since the objects of a kind differ in what is wrong with them; a finding's fold is the one kept for its object.
  - The full page starts with every section open but Metadata, and the inspector with the triage set, so a choice in one would read as a fault in the other: they keep their own.
  - The page's filter text and the place it was scrolled to are kept by the editor's URI, so the selection moving to another object of the kind leaves them as they were.
- **A filter shows what a fold hides.**
  It matches titles, labels, values, the rows of a container's groups and the defaults the page hides, opens the sections with a match, draws every event it keeps, and says `3 matches in 2 sections`; it uses the list's matcher, `parseText`, and not a third.
- **The core says what is wrong, and the webview how it looks.**
  - The core says the findings, a section's `summary`, `tone` and `fold`, which fields are `default`, which conditions are `explained`, the header's owner, node, sentence and vitals.
  - The webview takes a status word's tone from the list's own rule for that word, and the core's finding tone only where that rule calls the word healthy, as a Deployment past its progress deadline reads `4/4`; it also decides the hour in which a restart is news, as the list does, since a row raises one alarm.
- **Disclosure is a section, and groups that open in place inside it.**
  - A container's counts, `Details 4 · Env 5 · Mounts 1`, open its groups in place, and the groups of a tree block, a pod's affinity and the generic overview's spec and status, nest as deep as the object does, the first two levels open and those below folded.
  - A section, and a container's open group, hide the fields that hold the cluster's own value behind a link of their own, `5 defaults`.

## Why

The research the page rests on, read on 2026-11-19:

- Nielsen: "designs that go beyond 2 disclosure levels typically have low usability" ([Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/), 2006-12-03), which is why a container's counts open groups in place and not in a panel of their own; the page goes past two levels only where the object's own shape does, in a tree's groups and a group's defaults.
- Wang, on accordions: "Avoid hiding any crucial information within the collapsed panels" and "Allow users to open or collapse multiple sections at a time" ([Accordions on Desktop](https://www.nngroup.com/articles/accordions-on-desktop/), 2023-07-30), which is why a header carries a summary and a tone, why a finding opens its section, and why ⌥-click opens every section and any number stay open.
- One component draws an object's details wherever they appear, since Headlamp's drawer and its route show different sections of one object ([research](../research/details.md#the-drawer)), which is why the details and the full page share their header, vitals and sections.

The folds of a kind are kept for the kind because the choice is about the kind of page, and a finding's for its object because the fact that opened it belongs to that object.
A header that holds its height lets a person read the fact that changes, where a header that moves as each object comes makes every press look like a change.

## Consequences

- The page follows the Overview whichever view is shown, so the pill, the sentence, `resource.noContainerRuns`, the editor's subject and its row state are right on every view, and only the vitals' strip is drawn on the Overview alone: one describe and one Overview over the IPC for each open page and each change of its object; arrowing through rows is not slower for it, as measured at `b6823641` ([below](#what-following-the-overview-on-every-view-costs)).
- While the object comes, the page under the strip is the row's cells, and the page comes back with the object's first batch: 11 frames after each of six presses of ↓, 201 to 267 ms by the frames' own times, with the header and the strip at the same box in every sample, from a per-frame probe of the parts' boxes that is not in the repository (Chrome 157.0.8103.80, headless, on the mock at `c1711200`, 2026-11-19); `4f1450c5`, which has no strip, drew the row's cells for 10 or 11 frames and 200 to 267 ms, by the same probe on 2026-11-18 (`TODO.md`).
- Each line of the header and the vitals' cells draw hidden copies of their stages, per header and per cell, never per row.
- A fold's summary needs a rule in the describer of each section; a section with no useful line has none.

## What following the Overview on every view costs

`bench/harness.sh`'s app built at each tree, with a driver that pressed ↓ 64 times, about 300 ms apart, through the pods of kind 1.37 with 5,000 pods under churn of 100 changes/s, three runs of each tree in turn on 2026-11-18, on an Apple M4 Max, read these medians, the base being `4f1450c5` and the branch `b6823641`:

| What                                            | Base   | Branch |
| ----------------------------------------------- | ------ | ------ |
| The inspector's name painted, p50               | 14 ms  | 13 ms  |
| The Overview's first section painted, p50       | 223 ms | 222 ms |
| The first content painted on the YAML view, p50 | 236 ms | 239 ms |

The Overview's 222 ms holds the 150 ms of the dwell before an object opens (ARCHITECTURE 4.3).
Over 60 s on the YAML view of one pod that the churn patches, the branch received 72 Overview messages (70 to 73) where the base received 71 of the Related part (71 to 71), and the app's core, WebContent and GPU processes took 8.4 % of one core against 8.7 %, medians of three runs each: the part followed on every view replaces the one the base sent.
The driver is in no commit, and `b6823641` is before the header's lines were decided from hidden copies of their stages (`53c668cb`): this is what following the Overview on every view costs, and not what those copies cost.

## Where it is implemented

- The contract: `Header`, `Section.summary`, `tone` and `fold`, `Field.default`, `Condition.explained`, `EventList.listed` and `Value::Spans` in [`crates/twigo-ipc/src/object.rs`](../../crates/twigo-ipc/src/object.rs).
- The core: the kinds' layouts, summaries, findings, sentences and vitals in [`crates/twigo-describe/src`](../../crates/twigo-describe/src), `layout.rs` for the order, tones and folds, `header.rs` for the owner and the sentence.
- The page: [`packages/kube/src/object`](../../packages/kube/src/object), and [`Details.tsx`](../../packages/kube/src/Details.tsx) for the inspector: `Overview.tsx`, `outline.ts` and `overviewStates.ts` for folds, `pageFilter.ts` and `pageStates.ts` for the filter and the place, `HeaderLines.tsx`, `Vitals.tsx`, `verdict.ts`, `ObjectEditor.tsx` and `pageStage.ts`.
- The mock, which stands in for the core: [`packages/protocol/src/mock`](../../packages/protocol/src/mock), `header.ts`, `sections.ts`, `pods.ts`, `jobs.ts` and `objects.ts`, with `objects.json` written by the core's `overviews` test.
- The rule [`.claude/rules/object-page.md`](../../.claude/rules/object-page.md) holds it for work in these files.

---
paths:
  - "crates/twigo-describe/**"
  - "crates/twigo-ipc/src/object.rs"
  - "packages/kube/src/object/**"
  - "packages/kube/src/Details.tsx"
  - "packages/protocol/src/mock/header.ts"
  - "packages/protocol/src/mock/sections.ts"
  - "packages/protocol/src/mock/pods.ts"
  - "packages/protocol/src/mock/jobs.ts"
  - "packages/protocol/src/mock/objects.ts"
  - "packages/protocol/src/mock/objects.json"
---

# The object page

- Say a thing once: a fact is the pill, a vital, a section or a chip, never two of them ([decision](../../docs/decisions/object-page.md)).
  A pod's, a Deployment's, a StatefulSet's, a DaemonSet's and a node's sections are not named after the kind (a Job's, a CronJob's, a Service's, an Ingress's and a claim's first section is), a pod's usage is its vitals and a line on each container, and a condition says why only where it is wrong and no finding explains it.
- A fold never hides a finding.
  A section that holds what is wrong carries its tone and a summary that names it, one that holds a finding the Diagnostics section does not explain is `finding` and opens over what the person chose, and the full page keeps the rule.
- The core says what is wrong and the webview how it looks.
  Findings, a section's `summary`, `tone` and `fold`, `Field.default`, `Condition.explained`, the sentence and the vitals are `twigo-describe`'s; the pill's word and tone are the list's rule for its health column, with the core's finding tone only where that rule calls the word healthy.
- Each line of the header that is drawn, the vitals strip and a container's CPU and Memory line keep their height whatever the object, the state of its usage or the stage: draw a dash or an empty meter where an answer is still to come, never nothing, and never measure per row.
  A kind with no health column and no vitals (a Job, a Service, an Ingress, a claim, a ConfigMap) has its third line only with a sentence, which the core gives only with a finding, held until its object comes and no longer.
- Folds are kept per kind (`OverviewStates`), apart for the full page, and a finding's for its object; the filter's text and the place are kept by the editor's URI (`PageStates`).
- A filter shows what a fold hides: it opens the sections with a match, matches the defaults the page hides, draws every event it keeps, and is the list's matcher (`parseText`), not another.
- Disclosure is a section and, inside it, groups that open in place: a container's, and a tree's, which nest as the object does; defaults hide behind a link of their own at the end of a section or an open group.
- A time that ticks is an age or a span, drawn on the page's timer and again only when its text or role changes ([decision](../../docs/decisions/printed-durations.md)).
- The mock stands in for the core: its header, sentence, vitals and summaries are built from the same cells as its list row, so the two never disagree, and `objects.json` is the core's output, never written by hand.

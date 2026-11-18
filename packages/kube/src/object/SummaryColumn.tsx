import { useMemo, type Ref } from "react";
import type { Overview } from "@twigo/protocol";
import { Entry } from "@twigo/ui";
import { useChanges } from "@twigo/workbench";
import { outlineOf, type Outline } from "./outline";
import { compile } from "./pageFilter";
import type { PageStates } from "./pageStates";
import { Sentence } from "./values";
import type { Verdict } from "./verdict";
import { Vitals } from "./Vitals";
import type { VitalCell } from "./vitalCells";

/**
 * The full page's column that stays while the main one scrolls: the vitals two
 * by two, then the page's sections as an index that says what each holds, so
 * that it informs before anyone clicks it. It lists the sections the page's
 * filter keeps, as the page draws them, and a click takes the main column to
 * the section and opens it.
 */
export function SummaryColumn({
  frame,
  cells,
  verdict,
  overview,
  usage,
  pages,
  uri,
  onReach,
}: {
  frame: Ref<HTMLElement>;
  cells: readonly VitalCell[];
  verdict: Verdict | undefined;
  overview: Overview | undefined;
  /** Whether the page draws a usage section of its own, as a node's. */
  usage: boolean;
  pages: PageStates;
  uri: string;
  onReach: (section: Outline) => void;
}) {
  useChanges(pages.changes);
  const text = pages.text(uri);
  const outline = useMemo(() => {
    const { filter } = compile(text);
    return overview ? outlineOf(overview, usage, true, filter) : [];
  }, [overview, usage, text]);
  return (
    <aside
      ref={frame}
      aria-label="Summary"
      className="flex w-80 shrink-0 flex-col gap-3 overflow-auto border-r border-border-subtle py-3"
    >
      <Vitals cells={cells} verdict={verdict} layout="grid" />
      <ul aria-label="Sections" className="flex flex-col">
        {outline.map((section) => (
          <li key={section.id}>
            <Entry
              title={section.title}
              summary={
                section.summary.length > 0 && (
                  <Sentence spans={section.summary} />
                )
              }
              tone={section.tone}
              onClick={() => {
                onReach(section);
              }}
            />
          </li>
        ))}
      </ul>
    </aside>
  );
}

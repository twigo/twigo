import type { Gvr, Header, ShownUsage } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";
import { verdictOf, type Verdict } from "./verdict";
import {
  labelsOf,
  sameLabels,
  useHeldPerKind,
  vitalCells,
  type VitalCell,
} from "./vitalCells";

export const printedOf =
  (header: Header | undefined) =>
  (column: string): string | undefined =>
    header?.printed.find((cell) => cell.column === column)?.value;

/**
 * What the header and the vitals of an object say, the header the same on
 * every view and the vitals on the Overview: the verdict, from the cells the object printed
 * once it has come, and from the list row until then; the strip, whose places
 * the last object of its kind holds; and whether the third line is drawn: where
 * there is a verdict, a strip or a sentence, the strip's places and whether
 * there is a sentence being the last object's of its kind until the next comes,
 * so that the header does not move meanwhile.
 */
export function useHeader({
  gvr,
  header,
  found,
  usage,
  row,
}: {
  /** None for an address that names no object. */
  gvr: Gvr | undefined;
  header: Header | undefined;
  /** The tone of the findings the object's Overview carries. */
  found?: Tone | undefined;
  usage: ShownUsage | undefined;
  /** The list row's cell of a column, where the object has a row. */
  row?: (column: string) => string | undefined;
}): {
  verdict: Verdict | undefined;
  strip: readonly VitalCell[];
  line: boolean;
} {
  const kind = gvr ? `${gvr.group}/${gvr.resource}` : "";
  const own = gvr && header && vitalCells(gvr, header.vitals, usage, undefined);
  const labels = useHeldPerKind(kind, own && labelsOf(own), sameLabels);
  const strip =
    own ?? (gvr ? vitalCells(gvr, undefined, undefined, labels) : []);
  const sentenced =
    useHeldPerKind(
      kind,
      header && header.sentence.length > 0,
      (a, b) => a === b,
    ) ?? false;
  const verdict =
    gvr &&
    (header
      ? verdictOf(gvr, printedOf(header), found)
      : row && verdictOf(gvr, row));
  return {
    verdict,
    strip,
    line: verdict !== undefined || strip.length > 0 || sentenced,
  };
}

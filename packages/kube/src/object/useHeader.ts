import type { Gvr, Header, ShownUsage } from "@twigo/protocol";
import { verdictOf, type Verdict } from "./verdict";
import {
  labelsOf,
  sameLabels,
  useHeldPerKind,
  vitalCells,
  type VitalCell,
} from "./vitalCells";

/**
 * What the header and the vitals of an object say, which an object's page
 * draws the same on every view: the verdict, from the cells the object printed
 * once it has come, and from the list row until then; the strip, whose places
 * the last object of its kind holds; and whether the third line is drawn, for a
 * kind that has a verdict or vitals always, and for another where its last
 * object had a sentence, so that the header does not move while the next comes.
 */
export function useHeader({
  gvr,
  header,
  usage,
  row,
}: {
  /** None for an address that names no object. */
  gvr: Gvr | undefined;
  header: Header | undefined;
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
      ? verdictOf(
          gvr,
          (column) =>
            header.printed.find((cell) => cell.column === column)?.value,
        )
      : row && verdictOf(gvr, row));
  return {
    verdict,
    strip,
    line: verdict !== undefined || strip.length > 0 || sentenced,
  };
}

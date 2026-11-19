import { MARGIN } from "./pageStage";

/** Where the page filter's field sits in the views row, and how its count is worded. */
interface FilterStage {
  /** Beside the views, which keep their full width, rather than on a line of its own. */
  readonly beside: boolean;
  /** `3 in 2` rather than `3 matches in 2 sections`. */
  readonly short: boolean;
}

/** From the fullest, which the row takes while it has room. */
export const FILTER_STAGES: readonly FilterStage[] = [
  { beside: true, short: false },
  { beside: true, short: true },
  { beside: false, short: false },
  { beside: false, short: true },
];

/** The least a field is drawn at: its padding, icon and clear button, and room for some eight characters. */
const FIELD = 112;
/** The space between the field and its count, and the row's `pr-1.5` after it. */
const GAP = 6;

/** What the row and its parts take at their natural size, each 0 until measured. */
interface FilterWidths {
  readonly row: number;
  /** The views with every tab shown, at the widest count their tabs keep room for. */
  readonly views: number;
  readonly long: number;
  readonly short: number;
}

function need(
  { beside, short }: FilterStage,
  { views, long, short: brief }: FilterWidths,
): number {
  const count = short ? brief : long;
  return (beside ? views : 0) + FIELD + (count > 0 ? GAP + count : 0) + GAP;
}

/** The fullest stage that fits the row, and a fuller one than `current` only with `MARGIN` to spare; `current` until the row and the views are measured. */
export function fitFilter(widths: FilterWidths, current: number): number {
  if (widths.row <= 0 || widths.views <= 0) return current;
  const fits = FILTER_STAGES.findIndex(
    (stage, index) =>
      need(stage, widths) + (index < current ? MARGIN : 0) <= widths.row,
  );
  return fits < 0 ? FILTER_STAGES.length - 1 : fits;
}

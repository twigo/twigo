/**
 * The stage a row of actions should be at in `room` px, given what each
 * stage it has shown took (`needs`, undefined for a stage not shown yet):
 * one stage further when the current one does not fit, else the fullest that
 * is known to fit, since a stage's width is learnt only by showing it. Stage
 * 0 is the fullest and `last` the most compact, which stays when nothing fits.
 */
export function stageFor(
  needs: readonly (number | undefined)[],
  stage: number,
  room: number,
  last: number,
): number {
  if ((needs[stage] ?? 0) > room) return Math.min(stage + 1, last);
  let fullest = stage;
  while (fullest > 0 && (needs[fullest - 1] ?? Infinity) <= room) fullest--;
  return fullest;
}

/**
 * What the scope chip is cut or folded to: the room its name may take, or
 * the fold it takes in place of the name. Neither is the whole chip.
 */
export interface Chip {
  readonly max?: number;
  readonly fold?: "count" | "glyph";
}

/** The widths a chip takes in each form at its natural size; `count` is not there for one name. */
export interface ChipWidths {
  readonly full: number;
  readonly floor: number;
  readonly count: number | undefined;
}

/**
 * Coming back to a fuller form takes this many px more than the form does,
 * for the room is the row's width less the chip's, two widths each rounded
 * to a pixel, and the form a width was read in changes how they round.
 */
const BACK = 1;

const WHOLE: Chip = {};

/** How folded a chip is: 0 whole, 1 cut, 2 the glyph and the count, 3 the glyph. */
function levelOf(chip: Chip): number {
  if (chip.fold === "glyph") return 3;
  if (chip.fold === "count") return 2;
  return chip.max === undefined ? 0 : 1;
}

function fits(room: number, { full, floor, count }: ChipWidths): number {
  if (room >= full) return 0;
  if (room >= floor) return 1;
  return count !== undefined && room >= count ? 2 : 3;
}

/**
 * The form the scope chip takes in `room` px, after the stages of the row
 * have given what they give: the whole chip, its name cut to the room down
 * to its floor, the glyph with how many more follow, the glyph alone. `was`
 * is the form it has, which it leaves for a fuller one only with `BACK` px
 * to spare.
 */
export function chipFor(room: number, widths: ChipWidths, was: Chip): Chip {
  const level = Math.max(
    fits(room, widths),
    Math.min(levelOf(was), fits(room - BACK, widths)),
  );
  const next: Chip =
    level === 0
      ? WHOLE
      : level === 1
        ? { max: room }
        : { fold: level === 2 ? "count" : "glyph" };
  return next.max === was.max && next.fold === was.fold ? was : next;
}

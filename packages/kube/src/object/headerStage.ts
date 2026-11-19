import { MARGIN } from "./pageStage";

/**
 * How a text of a header's line is drawn at a stage: whole, cut in the
 * middle by CSS down to its floor and no further, or held at its floor.
 */
export type Form = "whole" | "cut" | "floor";

/** The characters a cut name keeps, head and tail together, at its floor. */
export const FLOOR = 12;

/**
 * The stages of the first line, fullest first. The kind word is never cut: it
 * leaves, and its icon says the kind. The name gives up its generated part as
 * a list row's does (`ObjectName`), then is cut in the middle.
 */
export interface TitleStage {
  readonly kind: boolean;
  readonly name: "whole" | "hash" | "middle";
}

export const TITLE_STAGES: readonly [TitleStage, ...TitleStage[]] = [
  { kind: true, name: "whole" },
  { kind: true, name: "hash" },
  { kind: false, name: "hash" },
  { kind: false, name: "middle" },
];

/**
 * The stages of the second line, fullest first. One text is cut by CSS at a
 * stage, the one the stage is about, and takes the room the stage leaves; a
 * text cut at an earlier stage is held at its floor, so that the browser never
 * chooses which of two texts to squeeze. The age never cuts and never leaves.
 */
export interface PlaceStage {
  readonly namespace: Form;
  readonly ownerKind: boolean;
  readonly owner: Form;
  readonly node: Form | "left";
}

export const PLACE_STAGES: readonly [PlaceStage, ...PlaceStage[]] = [
  { namespace: "whole", ownerKind: true, owner: "whole", node: "whole" },
  { namespace: "whole", ownerKind: true, owner: "whole", node: "cut" },
  { namespace: "whole", ownerKind: true, owner: "cut", node: "floor" },
  { namespace: "whole", ownerKind: false, owner: "cut", node: "floor" },
  { namespace: "whole", ownerKind: false, owner: "cut", node: "left" },
  { namespace: "cut", ownerKind: false, owner: "floor", node: "left" },
];

/** The two widths that are each rounded to a pixel when a stage's width is held against the room. */
const ROUNDED = 1;

/**
 * The fullest stage whose width fits `room`, where `needs` holds the width
 * each takes with its cut texts at their floors; a fuller stage than `current`
 * only with `MARGIN` to spare, unless `held` is false, as `current` was not
 * decided from measured widths. The last stage when none fits, and `current`
 * until the room and every stage are measured.
 */
export function fitStage(
  needs: readonly number[],
  room: number,
  current: number,
  held = true,
): number {
  if (room <= 0 || needs.length === 0 || needs.some((need) => need <= 0))
    return current;
  const fits = needs.findIndex(
    (need, stage) =>
      need + ROUNDED + (held && stage < current ? MARGIN : 0) <= room,
  );
  return fits < 0 ? needs.length - 1 : fits;
}

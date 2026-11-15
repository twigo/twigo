export interface TitleBarTexts {
  readonly name: string;
  readonly scope: string;
  readonly chip: string | undefined;
}

export interface TitleBarStage {
  readonly searchFolded: boolean;
  readonly chipFolded: boolean;
}

/** The name crumb is cut no further than this many characters, which a shorter name never is. */
export const NAME_FLOOR = 28;

const BAR_EDGES = 16 + 2 * 12;
const TRAFFIC_LIGHTS = 84;
const BREADCRUMB_SHARE = 1.3 / 2.3;
const SEARCH_FIELD = 300;
const SEARCH_ICON = 62;

const NAME_CHAR = 7.6;
const SCOPE_CHAR = 6.9;
const CRUMB = 32;
const BREADCRUMB_GAPS = 6 + 14;
const CHIP_CHAR = 5.8;
const CHIP_WORDS_FRAME = 38;
const CHIP_ICON = 34;

/**
 * Which parts of the title bar fold at a measured width: the search field to
 * an icon first, then the mode chip to its icon, so that the name and the
 * scope stay whole as long as they can. Past that the layout cuts the scope
 * in the middle, and the name only down to its floor.
 * The widths follow the bar's grid, where the breadcrumb has 1.3 parts of
 * what the search leaves; characters are estimated a little over what SF
 * measures, so a stage never claims room it lacks.
 */
export function titleBarStage(
  width: number,
  { name, scope, chip }: TitleBarTexts,
): TitleBarStage {
  if (width === 0) return { searchFolded: false, chipFolded: false };
  const room = (search: number) =>
    (width - BAR_EDGES - search) * BREADCRUMB_SHARE - TRAFFIC_LIGHTS;
  const need = (chipFolded: boolean) => {
    const chipWidth =
      chip === undefined
        ? 0
        : chipFolded
          ? CHIP_ICON
          : chip.length * CHIP_CHAR + CHIP_WORDS_FRAME;
    return (
      name.length * NAME_CHAR +
      scope.length * SCOPE_CHAR +
      2 * CRUMB +
      BREADCRUMB_GAPS +
      chipWidth
    );
  };
  if (need(false) <= room(SEARCH_FIELD)) {
    return { searchFolded: false, chipFolded: false };
  }
  if (need(false) <= room(SEARCH_ICON)) {
    return { searchFolded: true, chipFolded: false };
  }
  return { searchFolded: true, chipFolded: true };
}

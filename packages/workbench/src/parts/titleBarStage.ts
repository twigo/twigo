/** Where the traffic lights end: the breadcrumb starts after them (`trafficLightPosition` in `tauri.conf.json`). */
export const TRAFFIC_LIGHTS = 84;
export const SEARCH_FIELD = 300;
export const BAR_GAP = 12;
const BREADCRUMB_SHARE = 1.3;

/** The bar's columns: the search between the breadcrumb and an empty column that centres it, or at the right end. */
export function titleBarColumns(centred: boolean): string {
  return centred
    ? `minmax(0,${String(BREADCRUMB_SHARE)}fr) auto minmax(0,1fr)`
    : "minmax(0,1fr) auto";
}

/** What the hidden copies of the title bar's parts measure at their natural size. */
export interface TitleBarWidths {
  /** The breadcrumb with the chip's words, without the room for the traffic lights. */
  readonly crumbs: number;
  readonly crumbsChipFolded: number;
  readonly searchIcon: number;
}

export interface TitleBarStage {
  readonly searchFolded: boolean;
  readonly chipFolded: boolean;
  /** Whether the search sits in the middle, or at the right end once the crumbs have no room even folded. */
  readonly centred: boolean;
}

const UNFOLDED: TitleBarStage = {
  searchFolded: false,
  chipFolded: false,
  centred: true,
};

/**
 * Which parts of the title bar fold at a measured width: the search field to
 * an icon first, then the mode chip to its icon, so that the name and the
 * scope stay whole as long as they can; once both have folded and the crumbs
 * still do not fit, the search leaves the middle for the right end. Past that
 * the layout cuts the scope in the middle, and the name only down to its
 * floor. `width` is the bar's content width, as the observer reports it, and
 * the room the breadcrumb has is what its grid column leaves.
 */
export function titleBarStage(
  width: number,
  { crumbs, crumbsChipFolded, searchIcon }: TitleBarWidths,
): TitleBarStage {
  if (width === 0 || crumbs === 0 || crumbsChipFolded === 0 || searchIcon === 0)
    return UNFOLDED;
  const room = (search: number) =>
    ((width - 2 * BAR_GAP - search) * BREADCRUMB_SHARE) /
    (1 + BREADCRUMB_SHARE);
  const need = (breadcrumb: number) => TRAFFIC_LIGHTS + breadcrumb;
  if (need(crumbs) <= room(SEARCH_FIELD)) return UNFOLDED;
  if (need(crumbs) <= room(searchIcon)) {
    return { ...UNFOLDED, searchFolded: true };
  }
  return {
    searchFolded: true,
    chipFolded: true,
    centred: need(crumbsChipFolded) <= room(searchIcon),
  };
}

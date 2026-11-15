/** Where the traffic lights end: the breadcrumb starts after them (`trafficLightPosition` in `tauri.conf.json`). */
export const TRAFFIC_LIGHTS = 84;
export const SEARCH_FIELD = 300;
export const BAR_GAP = 12;
const BREADCRUMB_SHARE = 1.3;
const ROUNDING = 0.5;

/** The bar's columns: the search between the breadcrumb and an empty column that centres it, or at the right end. */
export function titleBarColumns(centred: boolean): string {
  return centred
    ? `minmax(0,${String(BREADCRUMB_SHARE)}fr) auto minmax(0,1fr)`
    : "minmax(0,1fr) auto";
}

/** The width the grid gives the breadcrumb's column in a bar `width` wide, with a search `search` wide. */
export function breadcrumbRoom(
  width: number,
  search: number,
  centred: boolean,
): number {
  return centred
    ? ((width - 2 * BAR_GAP - search) * BREADCRUMB_SHARE) /
        (1 + BREADCRUMB_SHARE)
    : width - BAR_GAP - search;
}

/** What the hidden copies of the title bar's parts measure at their natural size. */
export interface TitleBarWidths {
  /** The breadcrumb with the chip's words, without the room for the traffic lights. */
  readonly crumbs: number;
  readonly searchIcon: number;
}

export interface TitleBarStage {
  readonly searchFolded: boolean;
  readonly chipFolded: boolean;
  /** Whether the search sits in the middle, or at the right end. */
  readonly centred: boolean;
}

const UNFOLDED: TitleBarStage = {
  searchFolded: false,
  chipFolded: false,
  centred: true,
};

/**
 * Which parts of the title bar give way at a measured width, in this order:
 * the search field folds to an icon, the search leaves the middle for the
 * right end, the mode chip folds to its icon. Past that the layout cuts the
 * scope in the middle, and the name only down to its floor, so that the
 * chip, which says the context's mode, stays longest. The widths come
 * rounded, each off by up to half a pixel, so a part stays unfolded only
 * where it fits whichever way they were rounded. `width` is the bar's
 * content width, as the observer reports it, and the room the breadcrumb has
 * is what its grid column leaves.
 */
export function titleBarStage(
  width: number,
  { crumbs, searchIcon }: TitleBarWidths,
): TitleBarStage {
  if (width === 0 || crumbs === 0 || searchIcon === 0) return UNFOLDED;
  const fits = (search: number, centred: boolean) =>
    TRAFFIC_LIGHTS + crumbs + ROUNDING <=
    breadcrumbRoom(width - ROUNDING, search, centred);
  const icon = searchIcon + ROUNDING;
  if (fits(SEARCH_FIELD, true)) return UNFOLDED;
  if (fits(icon, true)) return { ...UNFOLDED, searchFolded: true };
  return {
    searchFolded: true,
    chipFolded: !fits(icon, false),
    centred: false,
  };
}

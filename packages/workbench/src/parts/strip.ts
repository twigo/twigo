/** The width of a list's tab in the editor area, the only tab the strip's stages keep room for: its title is cut at its end and only Close follows it, and `styles.css` caps the title so that the tab comes to this width. A tab with a state mark is wider, and so is one whose title is cut in the middle at a floor wider than the cap. */
export const TAB_MAX = 220;

/** The characters of an editor tab's title that its cut leaves, head and tail together. */
export const TITLE_FLOOR = 16;

/** The space before a strip's first tab, and between its tabs: `styles.css` draws both. */
export const TABS_START = 4;
export const TABS_GAP = 2;

/** What a group's strip keeps free for dockview's overflow button: its 24 px and the 4 px after it. */
export const OVERFLOW_BUTTON = 28;

/** The space after a group's actions, at the strip's right end. */
export const ACTIONS_PADDING = 6;

/** What a group's strip takes besides its actions, whatever they take: the space before the first tab, the active list's tab (`TAB_MAX`), the overflow button and the space after the actions. Only a list's actions read it. */
export const STRIP_KEPT =
  TABS_START + TAB_MAX + OVERFLOW_BUTTON + ACTIONS_PADDING;

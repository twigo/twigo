/** The widest an editor tab grows while only Close follows its title: `styles.css` caps the title so that the tab comes to this width, and a state mark after the title adds its own. */
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

/** What a group's strip takes besides its actions, whatever they take: the space before the first tab, the active tab at its widest, the overflow button and the space after the actions. */
export const STRIP_KEPT =
  TABS_START + TAB_MAX + OVERFLOW_BUTTON + ACTIONS_PADDING;

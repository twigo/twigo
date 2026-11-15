/** The widest a tab grows: `styles.css` cuts a longer title at this width. */
export const TAB_MAX = 220;

/** What a group's strip keeps free for dockview's overflow button, with room for a count of two digits. */
export const OVERFLOW_BUTTON = 48;

/** The space after a group's actions, at the strip's right end. */
export const ACTIONS_PADDING = 6;

/** What a group's strip takes besides its actions, whatever they take: the active tab at its widest, the overflow button and the space after the actions. */
export const STRIP_KEPT = TAB_MAX + OVERFLOW_BUTTON + ACTIONS_PADDING;

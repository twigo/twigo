/** The widest a tab grows: `styles.css` cuts a longer title at this width. */
export const TAB_MAX = 220;

/** What a group's strip keeps free for dockview's overflow button, with room for a count of two digits. */
export const OVERFLOW_BUTTON = 48;

/** What a group's strip keeps for its tabs, whatever its actions take: the active tab at its widest and the overflow button. */
export const TABS_KEPT = TAB_MAX + OVERFLOW_BUTTON;

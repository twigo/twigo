# Colours come only from the tokens in packages/ui

Decided 2026-10-31, in step 5 of M0 (ARCHITECTURE 4.9).

## Decision

- `packages/ui/src/styles/theme.css` holds every colour, for light and dark, and maps it into Tailwind under `@theme inline`.
- Outside `packages/ui`, ESLint rejects raw colours:
  - in TypeScript strings: hex colours, colour functions such as `oklch()`, and Tailwind palette utilities such as `bg-red-500`;
  - in CSS: hex colours, colour functions and named colours.
- `var(--token)` and `color-mix()` over tokens stay allowed.
- A new colour is a new token, with both themes, in `theme.css`.

## Why

The design language (D8) re-skins from one brand pair and keeps data near-monochrome.
A colour written at a call site escapes both: it ignores the theme and breaks the restraint rules without anyone deciding to.
The rule lives in `eslint.config.js` and reads the palette names from `tailwindcss/colors` and the CSS colour names from `color-name`, so neither list is copied by hand.

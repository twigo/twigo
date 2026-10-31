# Colours come only from the tokens in packages/ui

Decided 2026-10-31, in step 5 of M0 (ARCHITECTURE 4.9).

## Decision

- `packages/ui/src/styles/theme.css` holds every colour, for light and dark, and maps it into Tailwind under `@theme inline`.
- Outside `packages/ui`, ESLint rejects raw colours:
  - in TypeScript: colour functions such as `oklch()`, Tailwind palette utilities such as `bg-red-500`, named colours in arbitrary values such as `bg-[red]` and in JSX `style` colour properties, and hex colours where a colour must be, the whole string or an arbitrary value, so `issue #123` passes;
  - in CSS: hex colours, colour functions and named colours, also in custom properties, and palette utilities in `@apply`.
- `var(--token)` and `color-mix()` over tokens stay allowed.
- A new colour is a new token, with both themes, in `theme.css`.

## Why

The design language (D8) re-skins from one brand pair and keeps data near-monochrome.
A colour written at a call site escapes both: it ignores the theme and breaks the restraint rules without anyone deciding to.
The rule lives in `eslint.config.js` and reads the palette names from `tailwindcss/colors` and the CSS colour names from `color-name`, so neither list is copied by hand.

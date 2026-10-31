---
paths:
  - "apps/**"
  - "packages/**"
---

# Design tokens

- Colours come only from the tokens in `packages/ui/src/styles/theme.css`; ESLint rejects raw colours elsewhere ([decision](../../docs/decisions/design-tokens.md)).
- A new colour is a token with a light and a dark value, mapped under `@theme inline`.
- Review visual changes on the mock backend in a browser, in both themes (ARCHITECTURE 4.9).

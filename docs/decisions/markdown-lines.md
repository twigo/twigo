# Markdown is written one sentence per line

Decided 2026-10-31.

## Decision

- Prose in Markdown has one sentence per line, with no breaks inside a sentence.
- A list item starts on its marker's line; its next sentences follow on their own lines, indented to the item's text.
- A bold lead such as `**Decision.**` counts as a sentence.
- Headings, tables and code blocks stay as they are.
- Prettier keeps this as written (`proseWrap` stays `preserve`).

## Why

Hard wraps at 80 columns turn the source into a poem of half-sentences and make every edit re-flow a whole paragraph.
One sentence per line reads as prose in any editor that soft-wraps, renders the same on GitHub, and keeps a diff to the sentences that changed.

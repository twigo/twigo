/**
 * What a line of prose holds at its widest, 80 characters. A text's lines
 * are counted at that width, so a narrower column wraps it into at least as
 * many: a text counted as longer than a fold's lines is truncated there for
 * certain, and one counted as fitting is never folded without cause.
 */
const LINE = 80;

export function lineCount(text: string): number {
  return text
    .split("\n")
    .reduce(
      (lines, line) => lines + Math.max(1, Math.ceil(line.length / LINE)),
      0,
    );
}

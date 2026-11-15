const MOVES: Readonly<
  Record<string, (index: number, count: number) => number>
> = {
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  ArrowRight: (index, count) => (index + 1) % count,
  Home: () => 0,
  End: (_, count) => count - 1,
};

/** Where a key moves the focus along a row of `count` items from `index`, as WAI-ARIA's tabs and toolbars move it, or none for a key that does not move it. */
export function rovingMove(
  key: string,
  index: number,
  count: number,
): number | undefined {
  return MOVES[key]?.(index, count);
}

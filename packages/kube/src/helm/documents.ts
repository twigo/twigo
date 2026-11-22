/** A document of a release's manifest: where it starts and ends, and the file its `# Source:` comment names. */
export interface Document {
  readonly name: string;
  /** 1-based, inclusive. */
  readonly from: number;
  readonly to: number;
}

/**
 * The documents of a manifest text, as Helm splits it, at each `---` line,
 * which is what `@` lists in the manifest view. A document with no `# Source:`
 * comment is named by its place.
 */
export function documentsOf(text: string): readonly Document[] {
  const lines = text.split("\n");
  const starts = lines.flatMap((line, index) =>
    /^---[ \t]*$/.test(line) ? [index] : [],
  );
  return starts.flatMap((start, at) => {
    const end = starts[at + 1] ?? lines.length;
    const source = lines
      .slice(start + 1, end)
      .map((line) => /^# Source: (.+)$/.exec(line)?.[1])
      .find((found) => found !== undefined);
    return end - start > 1 && lines.slice(start + 1, end).some((l) => l.trim())
      ? [
          {
            name: source ?? `Document ${String(at + 1)}`,
            from: start + 2,
            to: end,
          },
        ]
      : [];
  });
}

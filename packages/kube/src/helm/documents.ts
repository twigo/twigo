import { landmarksOf, outlineOf } from "../edit/outline";

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

/** The offsets of the top-level keys of every document of a text, which a manifest has several of. */
export function topKeysOf(
  text: string,
): readonly (readonly [number, number])[] {
  const separators = [...text.matchAll(/^---[ \t]*$/gm)];
  const starts = [
    0,
    ...separators.map(({ index, 0: found }) => index + found.length + 1),
  ];
  const ends = [...separators.map(({ index }) => index), text.length];
  return starts.flatMap((start, at) =>
    landmarksOf(outlineOf(text.slice(start, ends[at]))).keys.map(
      ([from, to]) => [start + from, start + to] as const,
    ),
  );
}

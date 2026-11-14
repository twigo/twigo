import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseAllDocuments,
  type ParsedNode,
} from "yaml";
import { READING } from "./object";

/** A key of a block map or an item of a block sequence, with the lines it covers. */
export interface Entry {
  /** The key, or `[index]` for an item of a sequence. */
  readonly label: string;
  /** The first and the last line, 1-based. */
  readonly from: number;
  readonly to: number;
  /** Where the key stands in the text, as offsets; an item of a sequence has none. */
  readonly key?: readonly [start: number, end: number];
  readonly entries: readonly Entry[];
}

/**
 * The block structure of the manifest's first document, from the same parse
 * the editor reads it with. A flow collection is one entry's value and has no
 * entries of its own.
 */
export function outlineOf(text: string): readonly Entry[] {
  const lines = new LineCounter();
  try {
    const [document] = parseAllDocuments(text, {
      ...READING,
      lineCounter: lines,
    });
    return entriesOf(document?.contents ?? null, lines);
  } catch {
    // Text that nests past the stack has no outline.
    return [];
  }
}

function entriesOf(node: ParsedNode | null, lines: LineCounter): Entry[] {
  const span = (start: number, end: number) => ({
    from: lines.linePos(start).line,
    to: lines.linePos(Math.max(start, end - 1)).line,
  });
  if (isMap(node) && !node.flow) {
    return node.items.flatMap(({ key, value }) => {
      if (!isScalar(key)) return [];
      const [start, end] = key.range;
      return [
        {
          label: String(key.value),
          ...span(start, value ? value.range[1] : end),
          key: [start, end] as const,
          entries: entriesOf(value, lines),
        },
      ];
    });
  }
  if (isSeq(node) && !node.flow) {
    return node.items.map((item, index) => ({
      label: `[${String(index)}]`,
      ...span(item.range[0], item.range[1]),
      entries: entriesOf(item, lines),
    }));
  }
  return [];
}

/**
 * What the editor draws apart: the offsets of the top-level keys, and the
 * lines of `managedFields` under `metadata`, which the server fills and the
 * person seldom reads.
 */
export function landmarksOf(outline: readonly Entry[]): {
  readonly keys: readonly (readonly [number, number])[];
  readonly managed: { readonly from: number; readonly to: number } | undefined;
} {
  const managed = outline
    .find(({ label }) => label === "metadata")
    ?.entries.find(({ label }) => label === "managedFields");
  return {
    keys: outline.flatMap(({ key }) => (key ? [key] : [])),
    managed: managed && { from: managed.from, to: managed.to },
  };
}

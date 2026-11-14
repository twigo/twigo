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
    return entriesOf(document?.contents ?? null, text, lines);
  } catch {
    // Text that nests past the stack has no outline.
    return [];
  }
}

function entriesOf(
  node: ParsedNode | null,
  text: string,
  lines: LineCounter,
): Entry[] {
  const column = (offset: number) => lines.linePos(offset).col - 1;
  const span = (start: number, nodeEnd: number, reach: number) => {
    let end = nodeEnd;
    for (;;) {
      while (end > start && /\s/.test(text.charAt(end - 1))) end--;
      const first = text.lastIndexOf("\n", end - 1) + 1;
      const indent = /^( *)#/.exec(text.slice(first, end))?.[1]?.length;
      if (indent === undefined || indent >= reach || first <= start) break;
      end = first;
    }
    return {
      from: lines.linePos(start).line,
      to: lines.linePos(Math.max(start, end - 1)).line,
    };
  };
  if (isMap(node) && !node.flow) {
    return node.items.flatMap(({ key, value }) => {
      if (!isScalar(key)) return [];
      const [start, end] = key.range;
      return [
        {
          label: key.source,
          ...span(start, value ? value.range[2] : end, column(start) + 1),
          key: [start, end] as const,
          entries: entriesOf(value, text, lines),
        },
      ];
    });
  }
  if (isSeq(node) && !node.flow) {
    return node.items.map((item, index) => ({
      label: `[${String(index)}]`,
      ...span(item.range[0], item.range[2], column(item.range[0])),
      entries: entriesOf(item, text, lines),
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

/**
 * The keys from the root to the line, in the order they are met: the keys of
 * the maps and, joined to the key they belong to, the items of the sequences,
 * as `containers[0]`. A line that no entry covers, a blank one between two
 * top-level keys or one past the end, has no path; a comment inside a block or
 * at its end has the path of the block.
 */
export function pathAt(outline: readonly Entry[], line: number): string[] {
  const covers = ({ from, to }: Entry) => from <= line && line <= to;
  const path: string[] = [];
  for (let hit = outline.find(covers); hit; hit = hit.entries.find(covers)) {
    const parent = hit.key === undefined ? path.pop() : undefined;
    path.push(`${parent ?? ""}${hit.label}`);
  }
  return path;
}

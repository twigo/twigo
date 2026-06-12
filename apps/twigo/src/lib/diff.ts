import { diffLines } from "diff";

export interface DiffLine {
  type: "add" | "del" | "ctx";
  text: string;
}

// Line-by-line diff of two payloads, flattened to one entry per rendered line.
export function diffPayload(a: string, b: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const part of diffLines(a, b)) {
    const type = part.added ? "add" : part.removed ? "del" : "ctx";
    // diffLines blocks end with a trailing newline; drop it before splitting.
    for (const text of part.value.replace(/\n$/, "").split("\n")) {
      lines.push({ type, text });
    }
  }
  return lines;
}

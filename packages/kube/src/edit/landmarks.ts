import type { editor } from "./monaco";

/** The top-level keys at weight 600, by their class in `monaco.css`. */
export function topKeyMarks(
  keys: readonly (readonly [number, number])[],
  model: editor.ITextModel,
): editor.IModelDeltaDecoration[] {
  return keys.map(([start, end]) => {
    const from = model.getPositionAt(start);
    const to = model.getPositionAt(end);
    return {
      range: {
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: to.lineNumber,
        endColumn: to.column,
      },
      options: { inlineClassName: "twigo-yaml-top-key" },
    };
  });
}

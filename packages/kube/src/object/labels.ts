import { lineCount } from "./lines";

/** A key's domain prefix, with its `/`, and the name after it: `app.kubernetes.io/` and `name`. */
export function splitKey(key: string): { prefix: string; name: string } {
  const slash = key.lastIndexOf("/") + 1;
  return { prefix: key.slice(0, slash), name: key.slice(slash) };
}

export const LABELS_SHOWN = 3;

const FOLDS_FROM_THE_START = new Set([
  "kubectl.kubernetes.io/last-applied-configuration",
]);

const VALUE_LINES = 2;

/**
 * How a label's or an annotation's value starts: `hidden` for a copy of the
 * object that kubectl keeps, `clamped` to two lines for a longer value, else
 * `whole`.
 */
export function valueFold(
  key: string,
  value: string,
): "whole" | "clamped" | "hidden" {
  if (FOLDS_FROM_THE_START.has(key)) return "hidden";
  return lineCount(value) > VALUE_LINES ? "clamped" : "whole";
}

import type { Value } from "@twigo/protocol";

/** The longest text that stays beside a label: what the value column holds on one line at the inspector's width. */
const BESIDE = 40;

const longText = (text: string) => text.length > BESIDE || text.includes("\n");

/**
 * Whether a value takes the page's width under its label: labels and
 * annotations and lists always, unless they are empty, and text or code that
 * is long or has lines. Decided by the value and never by measuring the row.
 */
export function stacks(value: Value): boolean {
  switch (value.type) {
    case "text":
    case "code":
      return longText(value.text);
    case "labels":
      return value.labels.length > 0;
    case "list":
      return !isEmpty(value);
    case "time":
    case "link":
    case "toned":
      return false;
  }
}

/**
 * What copying a value gives: its text, a time as the moment it stands for,
 * and labels and lists a line for each item. None for a value that is empty.
 */
export function copyText(value: Value): string | undefined {
  switch (value.type) {
    case "text":
    case "code":
    case "toned":
    case "link":
      return value.text === "" ? undefined : value.text;
    case "time":
      return value.at;
    case "labels":
      return (
        value.labels
          .map(({ key, value: text }) => (text === "" ? key : `${key}=${text}`))
          .join("\n") || undefined
      );
    case "list":
      return (
        value.items
          .map(copyText)
          .filter((text) => text !== undefined)
          .join("\n") || undefined
      );
  }
}

/** Whether a value wraps over lines, which every one does but a name, cut in the middle with its whole text in its tooltip. */
const wraps = (value: Value) => value.type !== "link";

export function rowOf(value: Value): {
  stacked: boolean;
  wraps: boolean;
  copy: string | undefined;
} {
  return {
    stacked: stacks(value),
    wraps: wraps(value),
    copy: copyText(value),
  };
}

export function isEmpty(value: Value): boolean {
  return copyText(value) === undefined && value.type !== "time";
}

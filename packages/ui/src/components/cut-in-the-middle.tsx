import { cutText } from "../lib/cutText";

/**
 * A text CSS can cut only at its end, cut in the middle instead, with the head
 * and the tail fixed. The middle's floor of 2em holds a whole glyph and the
 * ellipsis: narrower, Chrome clips the ellipsis and leaves a letter that is
 * not in the text. Its `white-space` stays the grid's `pre`, which `truncate`
 * would turn to `nowrap` and drop the spaces at the ends.
 */
export function CutInTheMiddle({
  text,
  floor,
  separator,
}: {
  text: string;
  floor: number;
  separator: string | RegExp;
}) {
  const cut = cutText(text, floor, separator);
  if (!cut) return <span className="whitespace-pre">{text}</span>;
  return (
    <span className="grid grid-cols-[auto_minmax(2em,1fr)_auto] whitespace-pre">
      <span>{cut.head}</span>
      <span className="overflow-hidden text-ellipsis">{cut.middle}</span>
      <span>{cut.tail}</span>
    </span>
  );
}

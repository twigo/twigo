import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { cutText } from "../lib/cutText";
import { emWidth, fontOf, type Font } from "../lib/textWidth";

/**
 * What a text carries until its font is read, when it could be cut: a width
 * taken of it before then is of a text that is whole and may not stay so.
 */
export const CUT_PENDING = "data-cut-pending";

/**
 * A text CSS can cut only at its end, cut in the middle instead, with the head
 * and the tail fixed. The middle's floor of 2em holds a whole glyph and the
 * ellipsis: narrower, Chrome clips the ellipsis and leaves a letter that is
 * not in the text. A text whose middle measures no more than that floor is not
 * cut (`cutText`), so the track never leaves a gap; it is measured in the
 * element's own font before the first paint. Its `white-space` stays the
 * grid's `pre`, which `truncate` would turn to `nowrap` and drop the spaces at
 * the ends.
 */
export function CutInTheMiddle({
  text,
  floor,
  separator,
  inline = false,
  "aria-hidden": hidden,
}: {
  text: string;
  floor: number;
  separator: string | RegExp;
  /** Sits among words in a line that wraps, as one piece that wraps whole and is cut only where it alone is wider than the line. */
  inline?: boolean;
  /** For a text that a neighbour says whole: the cut's cells would read as separate words. */
  "aria-hidden"?: boolean;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [font, setFont] = useState<Font>();
  // That this runs before the first paint, and not after it, is held only in a
  // browser: jsdom paints nothing, so its tests cannot tell it from an effect.
  useLayoutEffect(() => {
    const read = box.current && fontOf(box.current);
    if (read) setFont(read);
  });
  const cut =
    font && cutText(text, floor, separator, (part) => emWidth(part, font));
  return (
    <span
      ref={box}
      aria-hidden={hidden}
      {...(font === undefined && text.length > floor && { [CUT_PENDING]: "" })}
      className={
        cut
          ? cn(
              "grid-cols-[auto_minmax(2em,1fr)_auto] whitespace-pre",
              inline ? "inline-grid max-w-full align-bottom" : "grid",
            )
          : "whitespace-pre"
      }
    >
      {cut ? (
        <>
          <span>{cut.head}</span>
          <span className="overflow-hidden text-ellipsis">{cut.middle}</span>
          <span>{cut.tail}</span>
        </>
      ) : (
        text
      )}
    </span>
  );
}

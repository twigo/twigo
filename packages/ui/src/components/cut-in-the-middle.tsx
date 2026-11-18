import { useLayoutEffect, useRef, useState } from "react";
import { cutText } from "../lib/cutText";
import { emWidth, fontOf, type Font } from "../lib/textWidth";

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
}: {
  text: string;
  floor: number;
  separator: string | RegExp;
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
      className={
        cut
          ? "grid grid-cols-[auto_minmax(2em,1fr)_auto] whitespace-pre"
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

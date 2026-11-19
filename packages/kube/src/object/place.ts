import type { Place } from "./pageStates";

const SECTIONS = "[data-section]";

/** The section at the top of what `scroller` shows and how far into it, none while it shows its top. */
export function placeOf(scroller: HTMLElement): Place | undefined {
  if (scroller.scrollTop === 0) return undefined;
  const top = scroller.getBoundingClientRect().top;
  let place: Place | undefined;
  for (const section of scroller.querySelectorAll<HTMLElement>(SECTIONS)) {
    const offset = top - section.getBoundingClientRect().top;
    if (offset < 0) break;
    place = {
      section: section.dataset.section ?? "",
      offset: Math.round(offset),
    };
  }
  return place;
}

/** Scrolls to the offset into the section of the place, cut at the section's height, and to the top where the page has no such section. Returns where it ended. */
function scrollTo(scroller: HTMLElement, place: Place): number {
  const section = Array.from(
    scroller.querySelectorAll<HTMLElement>(SECTIONS),
  ).find((candidate) => candidate.dataset.section === place.section);
  if (section) {
    const { top, height } = section.getBoundingClientRect();
    scroller.scrollTop +=
      top -
      scroller.getBoundingClientRect().top +
      Math.min(place.offset, height);
  }
  return scroller.scrollTop;
}

/**
 * Opens `scroller` at `place`, if there is one, and keeps it there while what
 * the page holds grows, as a usage that comes after the rest does, until the
 * scroll is more than a pixel from where the hold put it, however slowly it
 * got there. WebKit does not anchor a scroll to its content as Chrome does, so
 * what comes above the place would move it. Passes `record` the place of each
 * scroll after that which the person made: not the restore's own, and not a
 * clamp, where a page that got shorter, by another object or a filter, took
 * the scroll to its new end and left the person where they were. Returns what
 * stops it.
 */
export function keepPlace(
  scroller: HTMLElement,
  place: Place | undefined,
  record: (place: Place | undefined) => void,
): () => void {
  let holding = place !== undefined;
  let held = place ? scrollTo(scroller, place) : scroller.scrollTop;
  let last = held;
  const content = scroller.firstElementChild;
  const observer = new ResizeObserver(() => {
    if (!holding || !place) return;
    held = scrollTo(scroller, place);
  });
  if (content) observer.observe(content);
  const moved = () => {
    const was = last;
    last = scroller.scrollTop;
    if (holding) {
      if (Math.abs(last - held) <= 1) return;
      holding = false;
    }
    const end = scroller.scrollHeight - scroller.clientHeight;
    if (was > end + 1) return;
    record(placeOf(scroller));
  };
  scroller.addEventListener("scroll", moved);
  return () => {
    observer.disconnect();
    scroller.removeEventListener("scroll", moved);
  };
}

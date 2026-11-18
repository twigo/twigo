import type {
  Overview as Document,
  Section,
  TextFilter,
  Tone,
} from "@twigo/protocol";
import { keeps, USAGE_TITLE, viewOf } from "./pageFilter";

const USAGE = "core.usage";

const METADATA = "core.metadata";

/** The tone of the edge on the header of a section that holds what is wrong; the others have none. */
const EDGE: Readonly<Record<Tone, "error" | "warn" | undefined>> = {
  danger: "error",
  warning: "warn",
  success: undefined,
  neutral: undefined,
};

/** A section as its header and the full page's index say it. */
export interface Outline {
  readonly id: string;
  readonly title: string;
  readonly fold: Section["fold"];
  readonly summary: Section["summary"];
  readonly tone: "error" | "warn" | undefined;
}

/**
 * The sections of a page in order, a node's usage after its Diagnostics. The
 * full page opens every one but the Metadata, which the person opens, and a
 * section that holds a finding stays one, which opens over what was kept. Under
 * a filter only the sections it keeps are listed, as the page draws them.
 */
export function outlineOf(
  overview: Document,
  withUsage: boolean,
  fullPage: boolean,
  filter: TextFilter | null = null,
): Outline[] {
  const outline = overview.sections.map((section): Outline => ({
    id: section.id,
    title: section.title,
    fold:
      section.fold === "finding" || !fullPage
        ? section.fold
        : section.id === METADATA
          ? "folded"
          : "open",
    summary: section.summary,
    tone: section.tone === null ? undefined : EDGE[section.tone],
  }));
  if (withUsage)
    outline.splice(overview.sections[0]?.id === "core.diagnostics" ? 1 : 0, 0, {
      id: USAGE,
      title: USAGE_TITLE,
      fold: "open",
      summary: [],
      tone: undefined,
    });
  if (filter === null) return outline;
  return outline.filter((entry) => {
    const section = overview.sections.find(({ id }) => id === entry.id);
    return keeps(
      filter,
      section && viewOf(section, filter, false),
      entry.title,
    );
  });
}

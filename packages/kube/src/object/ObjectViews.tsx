import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ObjectSnapshot } from "@twigo/protocol";
import { cn, SearchField, TabBar, useWidth } from "@twigo/ui";
import { useChanges } from "@twigo/workbench";
import { FILTER_STAGES, fitFilter } from "./filterStage";
import { compile, describeMatches, matchesIn } from "./pageFilter";
import type { PageStates } from "./pageStates";

/** Warning events of the object, from its Overview or its Events view, whichever came. */
function warningCount({
  overview,
  events,
}: Pick<ObjectSnapshot, "overview" | "events">): number {
  const listed =
    events?.events ??
    overview?.sections
      .flatMap((section) => section.blocks)
      .flatMap((block) => (block.type === "events" ? block.events : []));
  return (listed ?? []).filter((event) => event.type === "Warning").length;
}

/** The digits the Events count keeps room for, in the room the row reads. */
const EVENT_DIGITS = 2;

/**
 * The most matches and sections the count of a filter keeps room for. The row's
 * stage is decided by this wording and two digits of warnings, never by what
 * an object's page happens to give: a page that finds more squeezes the field
 * within its stage.
 */
const MOST_MATCHES = 99;
const MOST_SECTIONS = 9;
const LONG_ROOM = describeMatches(MOST_MATCHES, MOST_SECTIONS);
const SHORT_ROOM = describeMatches(MOST_MATCHES, MOST_SECTIONS, true);

/**
 * The views of an object as one row (ARCHITECTURE 4.3), at the top of its
 * content in the details and in an editor alike: Overview, YAML, Events with
 * its warnings counted, and Related. Over the Overview the row also holds the
 * filter of its page, once `/` opens it, and says what the filter matched. The
 * views keep every tab beside the field, which takes what the row leaves, or a
 * line of its own where that is under its floor, and words its count shorter
 * where that makes room. Which of these the row takes is decided before it
 * paints, from the views with room for two digits of warnings and the count
 * worded for 99 matches in 9 sections, so that it is the same for every object
 * and for every text; a count with more digits squeezes the field within its
 * stage. It holds while the field or its Clear button has the focus.
 */
export function ObjectViews<V extends string>({
  tab,
  tabs,
  snapshot,
  onChange,
  pages,
  uri,
  kind,
}: {
  tab: V;
  /** The views, the one called `overview` carrying the filter. */
  tabs: readonly { readonly id: V; readonly title: string }[];
  snapshot: Pick<ObjectSnapshot, "overview" | "events" | "usage">;
  onChange: (tab: V) => void;
  pages: PageStates;
  uri: string;
  kind: string;
}) {
  useChanges(pages.changes);
  const warnings = warningCount(snapshot);
  const text = pages.text(uri);
  const { filter, invalid } = useMemo(() => compile(text), [text]);
  const { overview, usage } = snapshot;
  const usageSection = usage !== undefined && kind === "Node";
  const found = useMemo(
    () =>
      filter && overview
        ? matchesIn(overview, filter, usageSection)
        : undefined,
    [filter, overview, usageSection],
  );
  const field = useRef<HTMLInputElement>(null);
  const wanted = pages.wantsFocus(uri);
  useEffect(() => {
    if (!wanted) return;
    field.current?.focus();
    pages.focused(uri);
  }, [wanted, pages, uri]);
  const filtering = tab === "overview" && pages.shown(uri);
  const [views, setViews] = useState(0);
  const [fit, setFit] = useState(0);
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const fieldBox = useRef<HTMLDivElement>(null);
  const wide = useRef<HTMLSpanElement>(null);
  const brief = useRef<HTMLSpanElement>(null);
  const [moves, leave] = useReducer((moved: number) => moved + 1, 0);
  const taken = useWidth(row);
  useLayoutEffect(() => {
    if (!filtering || !row) return;
    if (fieldBox.current?.contains(document.activeElement)) return;
    const next = fitFilter(
      {
        row: row.clientWidth,
        views,
        long: wide.current?.clientWidth ?? 0,
        short: brief.current?.clientWidth ?? 0,
      },
      fit,
    );
    if (next !== fit) setFit(next);
  }, [filtering, row, taken, views, fit, moves]);
  const stage = FILTER_STAGES[fit] ?? FILTER_STAGES[0];
  const beside = filtering && stage?.beside === true;
  const long = invalid
    ? "Not a regex"
    : found && describeMatches(found.matches, found.sections);
  const short = invalid
    ? "Not a regex"
    : found && describeMatches(found.matches, found.sections, true);
  return (
    <div
      ref={setRow}
      className={cn(
        "relative flex shadow-[inset_0_-1px_0_var(--border-subtle)]",
        filtering && !beside ? "flex-col" : "items-center",
      )}
    >
      <div
        className={
          !filtering ? "min-w-0 flex-1" : beside ? "shrink-0" : undefined
        }
        style={beside && views > 0 ? { minWidth: views } : undefined}
      >
        <TabBar
          label="Views of the object"
          tabs={tabs.map(({ id, title }) => ({
            value: id,
            label: title,
            ...(id === "events" && {
              count: warnings,
              warn: true,
              digits: EVENT_DIGITS,
            }),
          }))}
          value={tab}
          onChange={onChange}
          onFullWidth={setViews}
          folds={!beside}
          className="w-full"
        />
      </div>
      {filtering && (
        <div
          ref={fieldBox}
          onKeyDownCapture={(event) => {
            if (event.key !== "Escape" || text !== "") return;
            event.preventDefault();
            event.stopPropagation();
            pages.focusPage(uri);
            pages.closeFilter(uri);
          }}
          onBlur={(event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            if (text === "") pages.closeFilter(uri);
            else leave();
          }}
          className={
            beside ? "ml-auto max-w-80 min-w-0 flex-1 pr-1.5" : "px-1.5 pb-1.5"
          }
        >
          <SearchField
            label="Filter this page"
            placeholder={`Filter this ${kind}`}
            keys="/"
            value={text}
            inputRef={field}
            onChange={(next) => {
              pages.setText(uri, next);
            }}
            onEnter={() => {
              pages.goToMatch(uri);
            }}
            trailing={
              <>
                <span role="status" className="sr-only">
                  {long}
                </span>
                <span aria-hidden className="shrink-0 tabular-nums">
                  {stage?.short === true ? short : long}
                </span>
              </>
            }
          />
        </div>
      )}
      {filtering && (
        <div
          aria-hidden
          className="invisible absolute top-0 left-0 h-0 overflow-hidden"
        >
          <span ref={wide} className="block w-max text-xs tabular-nums">
            {LONG_ROOM}
          </span>
          <span ref={brief} className="block w-max text-xs tabular-nums">
            {SHORT_ROOM}
          </span>
        </div>
      )}
    </div>
  );
}

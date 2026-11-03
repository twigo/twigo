import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { CircleAlert, History, Hourglass, ScrollText } from "lucide-react";
import type { LogView } from "@twigo/protocol";
import {
  Banner,
  Button,
  EmptyState,
  Histogram,
  LineList,
  Skeleton,
  type HistogramSpan,
  type LinePlace,
  type LineWindow,
} from "@twigo/ui";
import {
  useChanges,
  useListRegistration,
  useWorkbench,
  type EditorProps,
} from "@twigo/workbench";
import { useNow } from "../useNow";
import { useWidth } from "../useWidth";
import { parseLogsUri } from "../uri";
import { ViewStatus } from "../ViewStatus";
import { viewProblem } from "../viewProblem";
import {
  anchoredMatch,
  currentMatch,
  followed,
  lineItem,
  podTag,
} from "./entries";
import { LogsToolbar } from "./LogsToolbar";
import type { LogsTabs } from "./state";

/**
 * A logs tab in the panel (ARCHITECTURE 4.6): one toolbar, the volume over
 * time, and the lines of a pod or of a workload's pods, which Rust buffers,
 * filters and searches; the tab shows a window of them.
 */
export function LogsEditor({ uri, tabs }: EditorProps & { tabs: LogsTabs }) {
  const { keys, lists } = useWorkbench();
  useChanges(tabs.changes);
  const input = useMemo(() => parseLogsUri(uri), [uri]);
  const session = useMemo(
    () => (input ? tabs.session(uri, input) : undefined),
    [input, tabs, uri],
  );
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? NO_SUBSCRIBE,
    () => session?.getSnapshot(),
  );
  const tab = tabs.get(uri);
  const now = useNow(1000);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const width = useWidth(element);

  const register = useListRegistration({ logLines: true });

  // `/` focuses the filter, as in a list.
  useEffect(() => {
    if (!element) return;
    const scope = keys.scope(element);
    scope.set("logsFocus", true);
    const unregister = lists.register(element, {
      filter: () => {
        tabs.focus(uri, "filter");
      },
    });
    return () => {
      unregister();
      scope.dispose();
    };
  }, [element, keys, lists, tabs, uri]);

  const entries = snapshot?.window?.entries;
  useEffect(() => {
    if (entries) tabs.saw(uri, entries);
  }, [entries, tabs, uri]);

  // Matches come and go around the one the person stepped to; it stays the
  // current one while its entry is in the window.
  const matchesNow = snapshot?.matches;
  const windowNow = snapshot?.window;
  const { anchor, current } = tabs.get(uri);
  const { steps, follow } = tabs.get(uri);
  useEffect(() => {
    if (!matchesNow || !windowNow || follow || steps === 0) return;
    if (!anchor) {
      // The match stepped to holds once its entry is in the window.
      const found = currentMatch(matchesNow, current);
      const entry = found && windowNow.entries[found.index - windowNow.start];
      if (found && entry)
        tabs.update(uri, { anchor: { id: entry.id, fromEnd: found.fromEnd } });
      return;
    }
    const at = windowNow.entries.findIndex((entry) => entry.id === anchor.id);
    if (at < 0) return;
    const back = anchoredMatch(
      matchesNow,
      windowNow.start + at,
      anchor.fromEnd,
    );
    if (back !== undefined && back !== current)
      tabs.update(uri, { current: back });
  }, [anchor, current, follow, matchesNow, steps, windowNow, tabs, uri]);

  const onWindow = useCallback(
    (window: LineWindow) => {
      session?.setWindow(
        "tail" in window
          ? { type: "tail", count: window.tail }
          : "around" in window
            ? {
                type: "around",
                id: Number(window.around),
                before: window.before,
                after: window.after,
              }
            : { type: "range", start: window.start, end: window.end },
      );
    },
    [session],
  );
  const onFollowChange = useCallback(
    (follow: boolean) => {
      tabs.follow(uri, follow);
    },
    [tabs, uri],
  );
  const onPlace = useCallback(
    (place: LinePlace) => {
      tabs.keepPlace(uri, place);
    },
    [tabs, uri],
  );

  if (!input || !session || !snapshot)
    return <EmptyState title="Not a logs tab">{uri}</EmptyState>;

  const { status, pods, window, matches, histogram, total } = snapshot;
  const several = (pods ?? []).some((pod) => followed(pod).length > 1);
  const tag = (pod: string, container: string) =>
    several ? `${podTag(pod)}/${container}` : podTag(pod);
  const match = currentMatch(matches, tab.current);
  const start = window?.start ?? 0;
  const items = (window?.entries ?? []).map((entry, index) =>
    lineItem(entry, {
      tag,
      accent: (pod) => tabs.joined(uri, pod),
      current: match?.index === start + index ? match.fromEnd : undefined,
      now,
    }),
  );
  // One character to spare: WebKit cut a five-character tag in 5ch with an
  // ellipsis.
  const tagWidth =
    1 +
    Math.min(24, Math.max(5, ...items.map((item) => item.tag?.length ?? 0)));
  const queued = (pods ?? []).filter((pod) =>
    pod.containers.some((container) => container.stream.state === "queued"),
  ).length;
  const failed = (pods ?? []).flatMap((pod) =>
    pod.containers.flatMap((container) =>
      container.stream.state === "error"
        ? [
            {
              name: `${podTag(pod.name)}/${container.name}`,
              error: container.stream.error,
            },
          ]
        : [],
    ),
  );
  const problem = viewProblem(status, "logs");
  const narrowed = viewNarrows(tab.view);

  const span: HistogramSpan | undefined =
    histogram && tab.view.range
      ? spanOf(histogram.from, histogram.to, tab.view.range)
      : undefined;

  return (
    <div ref={setElement} className="flex h-full min-h-0 flex-col bg-editor">
      <LogsToolbar
        uri={uri}
        input={input}
        tabs={tabs}
        snapshot={snapshot}
        session={session}
        narrow={width > 0 && width < 1100}
        compact={width > 0 && width < 800}
      />
      {histogram && histogram.buckets.length > 0 && (
        <Histogram
          label="Lines over time"
          buckets={histogram.buckets.map((bucket) => ({
            total: bucket.lines,
            warnings: bucket.warnings,
            errors: bucket.errors,
          }))}
          ticks={ticks(histogram.from, histogram.to, now)}
          selection={span}
          onSelect={({ from, to }) => {
            const begin = Date.parse(histogram.from);
            const length = Date.parse(histogram.to) - begin;
            tabs.setView(uri, {
              range: {
                from: new Date(begin + from * length).toISOString(),
                to: new Date(begin + to * length).toISOString(),
              },
            });
          }}
          className="border-b border-border-subtle"
        />
      )}
      {tab.source.previous && (
        <Banner
          tone="info"
          icon={History}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                tabs.setSource(uri, { previous: false });
              }}
            >
              Show current
            </Button>
          }
        >
          <span className="font-medium">Previous container</span>, the instance
          that ended before the one running now
        </Banner>
      )}
      {queued > 0 && (
        <Banner tone="warn" icon={Hourglass}>
          <span className="font-medium">
            {queued} {queued === 1 ? "pod waits" : "pods wait"} for a log
            stream.
          </span>{" "}
          The cluster has 32 followed logs open, the most Twigo opens on one
          cluster; close a logs tab to free some.
        </Banner>
      )}
      {failed[0] && (
        <Banner tone="error" icon={CircleAlert}>
          <span className="font-medium">
            {failed.length === 1
              ? `Cannot read the logs of ${failed[0].name}:`
              : `Cannot read the logs of ${String(failed.length)} containers, ${failed[0].name} first:`}
          </span>{" "}
          {failed[0].error.message}
        </Banner>
      )}
      {problem && total > 0 && (
        <Banner tone="error" icon={problem.icon}>
          <span className="font-medium">{problem.title}.</span> {problem.body}{" "}
          The lines read so far stay.
        </Banner>
      )}
      {status.state === "queued" && (
        <Banner tone="warn" icon={Hourglass}>
          <span className="font-medium">Waiting for a watch of the pods.</span>{" "}
          The cluster's watches are taken; one frees as a list closes.
        </Banner>
      )}
      {problem && total === 0 ? (
        <ViewStatus status={status} what="logs" />
      ) : (
        // The list stays mounted under what covers it, since its window is
        // what asks Rust for the lines.
        <div className="relative flex min-h-0 flex-1 flex-col">
          <LineList
            label={`Logs of ${input.name}`}
            total={total}
            start={start}
            items={items}
            follow={tab.follow}
            wrap={tab.wrap}
            timestamps={tab.timestamps}
            tagWidth={tagWidth}
            reveal={
              match && tab.steps > 0
                ? { index: match.index, token: tab.steps }
                : undefined
            }
            fresh={Math.max(0, snapshot.arrived - tab.pausedAt)}
            place={tabs.place(uri)}
            onWindow={onWindow}
            onFollowChange={onFollowChange}
            onPlace={onPlace}
            register={register}
            className="flex-1"
          />
          {!window ? (
            <div className="absolute inset-0 flex flex-col gap-2 bg-editor p-3">
              {[64, 48, 72, 56].map((size) => (
                <Skeleton
                  key={size}
                  className="h-3"
                  style={{ width: `${String(size)}%` }}
                />
              ))}
            </div>
          ) : (
            total === 0 && (
              <EmptyState
                icon={ScrollText}
                title={narrowed ? "No lines match" : "No lines yet"}
                className="absolute inset-0 bg-editor"
              >
                <p>
                  {narrowed
                    ? "Clear the filter, the level or the range to see every line."
                    : "Lines show here as the containers write them."}
                </p>
              </EmptyState>
            )
          )}
        </div>
      )}
    </div>
  );
}

const NO_SUBSCRIBE = () => () => undefined;

function viewNarrows(view: LogView): boolean {
  return view.level !== "all" || view.filter !== null || view.range !== null;
}

function spanOf(
  from: string,
  to: string,
  range: { from: string; to: string },
): HistogramSpan {
  const begin = Date.parse(from);
  const length = Math.max(1, Date.parse(to) - begin);
  return {
    from: (Date.parse(range.from) - begin) / length,
    to: (Date.parse(range.to) - begin) / length,
  };
}

/** Four labels under the histogram, its end `now` while it reaches the present. */
function ticks(from: string, to: string, now: number): string[] {
  const begin = Date.parse(from);
  const end = Date.parse(to);
  const seconds = end - begin < 15 * 60_000;
  const label = (at: number) =>
    new Date(at).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      ...(seconds && { second: "2-digit" }),
    });

  return [0, 1, 2, 3].map((step) => {
    const at = begin + ((end - begin) * step) / 3;
    return step === 3 && now - end < 5000 ? "now" : label(at);
  });
}

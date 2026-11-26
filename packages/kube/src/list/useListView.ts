import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  INITIAL_SNAPSHOT,
  ListView,
  viewOf,
  type Backend,
  type ListQuery,
  type ViewQuery,
} from "@twigo/protocol";
import { FlashTracker } from "./flash";

interface Live {
  view: ListView;
  flash: FlashTracker;
  query: ListQuery;
}

function sameList(a: ListQuery, b: ListQuery): boolean {
  return (
    a.space === b.space &&
    a.gvr.group === b.gvr.group &&
    a.gvr.resource === b.gvr.resource
  );
}

const NO_VIEW: ViewQuery = {
  text: null,
  columns: null,
  sort: null,
  countBy: null,
  groupBy: null,
  values: null,
};

const idle = () => INITIAL_SNAPSHOT;
const never = () => () => undefined;

/**
 * Subscribes while mounted, once there is a query. The view part of the
 * query, its text, sort, counts, groups and values, changes on the
 * subscription the list has: the rows on screen stay until the first batch
 * that names the change, and the query returned is the one they answer.
 * Anything else in the query, such as its namespaces, is a new subscription;
 * until its first batch the previous one stays on screen and stays open, so
 * the scopes the old subscription read keep their reader and their samples,
 * and the new one starts with the metrics state the old one said. The
 * window, and whether the list reads its metric columns, always go to the
 * newest subscription, and the second never opens another.
 */
export function useListView(backend: Backend, query: ListQuery | undefined) {
  const key = query && JSON.stringify({ ...query, ...NO_VIEW });
  const shape = query && JSON.stringify(viewOf(query));
  const asked = useRef(query);
  useEffect(() => {
    asked.current = query;
  });
  const [live, setLive] = useState<Live>();
  const shownOnce = useRef(false);
  const window = useRef<readonly [number, number]>([0, 40]);
  const reads = useRef(false);
  const newest = useRef<ListView>(undefined);
  const current = useRef<Live>(undefined);
  /** Ends the subscription on screen, which its successor's first batch replaces. */
  const onScreen = useRef<() => void>(undefined);

  const leave = useCallback(() => {
    onScreen.current?.();
    onScreen.current = undefined;
    current.current = undefined;
  }, []);

  useEffect(() => {
    const wanted = asked.current;
    if (key === undefined || !wanted) {
      leave();
      return;
    }
    const query: ListQuery = wanted;
    const before = current.current;
    const view = new ListView(
      backend,
      query,
      before && sameList(before.query, query)
        ? before.view.getSnapshot().metrics
        : null,
    );
    const flash = new FlashTracker(query.gvr);
    newest.current = view;
    view.setMetrics(reads.current);
    view.setWindow(...window.current);
    let shown = false;
    const record = view.subscribe(() => {
      flash.record(view.getSnapshot(), performance.now());
      if (!shown) show();
    });
    const end = () => {
      record();
      view.close();
    };
    function show() {
      shown = true;
      current.current = { view, flash, query };
      setLive({ view, flash, query });
      const before = onScreen.current;
      onScreen.current = end;
      before?.();
    }
    if (!shownOnce.current) {
      shownOnce.current = true;
      show();
    }
    return () => {
      if (!shown) end();
    };
  }, [backend, key, leave]);

  useEffect(() => {
    if (shape !== undefined) {
      newest.current?.setView(JSON.parse(shape) as ViewQuery);
    }
  }, [shape]);

  useEffect(() => leave, [leave]);

  const setWindow = useCallback((start: number, end: number) => {
    window.current = [start, end];
    newest.current?.setWindow(start, end);
  }, []);

  const setMetrics = useCallback((metrics: boolean) => {
    reads.current = metrics;
    newest.current?.setMetrics(metrics);
  }, []);

  const snapshot = useSyncExternalStore(
    live?.view.subscribe ?? never,
    live?.view.getSnapshot ?? idle,
  );
  /** `query` is the one the snapshot answers, which trails a new query until its first batch. */
  return {
    snapshot,
    flash: live?.flash,
    query: live?.view.queryOf(snapshot.view),
    setWindow,
    setMetrics,
  };
}

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
  type Backend,
  type ListQuery,
} from "@twigo/protocol";
import { FlashTracker } from "./flash";

interface Live {
  view: ListView;
  flash: FlashTracker;
}

const idle = () => INITIAL_SNAPSHOT;
const never = () => () => undefined;

/**
 * Subscribes while mounted. A new query means a new subscription; until its
 * first batch the previous one stays on screen, so a sort does not blank the
 * table. The window always goes to the newest subscription.
 */
export function useListView(backend: Backend, query: ListQuery) {
  const key = JSON.stringify(query);
  const [live, setLive] = useState<Live>();
  const shownOnce = useRef(false);
  const window = useRef<readonly [number, number]>([0, 40]);
  const newest = useRef<ListView>(undefined);

  useEffect(() => {
    const view = new ListView(backend, JSON.parse(key) as ListQuery);
    const flash = new FlashTracker();
    newest.current = view;
    view.setWindow(...window.current);
    let shown = !shownOnce.current;
    const record = view.subscribe(() => {
      flash.record(view.getSnapshot(), performance.now());
      if (!shown) {
        shown = true;
        setLive({ view, flash });
      }
    });
    if (!shownOnce.current) {
      shownOnce.current = true;
      setLive({ view, flash });
    }
    return () => {
      record();
      view.close();
    };
  }, [backend, key]);

  const setWindow = useCallback((start: number, end: number) => {
    window.current = [start, end];
    newest.current?.setWindow(start, end);
  }, []);

  const snapshot = useSyncExternalStore(
    live?.view.subscribe ?? never,
    live?.view.getSnapshot ?? idle,
  );
  return { snapshot, flash: live?.flash, setWindow };
}

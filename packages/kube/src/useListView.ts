import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
 * table. `window` is the range the table shows, handed to each new view.
 */
export function useListView(
  backend: Backend,
  query: ListQuery,
  window: { readonly current: readonly [number, number] },
) {
  const key = JSON.stringify(query);
  const [live, setLive] = useState<Live>();
  const shownOnce = useRef(false);

  useEffect(() => {
    const view = new ListView(backend, JSON.parse(key) as ListQuery);
    const flash = new FlashTracker();
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
  }, [backend, key, window]);

  const snapshot = useSyncExternalStore(
    live?.view.subscribe ?? never,
    live?.view.getSnapshot ?? idle,
  );
  return { snapshot, view: live?.view, flash: live?.flash };
}

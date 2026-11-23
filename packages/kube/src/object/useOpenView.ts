import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Backend, OpenView, ViewState } from "@twigo/protocol";

const NOTHING = () => () => undefined;

/**
 * An open view while `query` names one, following what `ask` asks for.
 * Another query opens its own, which replaces the last one's on its first
 * batch; the snapshot is only ever the current query's.
 */
export function useOpenView<
  Q,
  A,
  S extends { readonly status: ViewState },
  V extends OpenView<A, { readonly seq: number }, S>,
>(
  backend: Backend,
  open: (backend: Backend, query: Q, ask: A) => V,
  query: Q | undefined,
  ask: A,
  initial: () => S,
) {
  const key = query && JSON.stringify(query);
  const asking = JSON.stringify(ask);
  const [live, setLive] = useState<{ key: string; view: V }>();
  const asked = useRef(asking);
  useEffect(() => {
    asked.current = asking;
  }, [asking]);
  useEffect(() => {
    if (key === undefined) return;
    const view = open(
      backend,
      JSON.parse(key) as Q,
      JSON.parse(asked.current) as A,
    );
    const first = view.subscribe(() => {
      first();
      setLive({ key, view });
    });
    return () => {
      first();
      view.close();
      setLive((shown) => (shown?.view === view ? undefined : shown));
    };
  }, [backend, open, key]);
  const current = live?.key === key ? live?.view : undefined;
  useEffect(() => {
    current?.setAsk(JSON.parse(asking) as A);
  }, [current, asking]);
  const snapshot = useSyncExternalStore(
    current?.subscribe ?? NOTHING,
    current?.getSnapshot ?? initial,
  );
  const id = useMemo(() => current && (() => current.id()), [current]);
  return { snapshot, current, id };
}

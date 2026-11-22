import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  INITIAL_RELEASE,
  ReleaseView,
  type Backend,
  type ReleaseAsk,
  type ReleaseRef,
} from "@twigo/protocol";

const NOTHING = () => () => undefined;
const INITIAL = () => INITIAL_RELEASE;

/**
 * An open release while `release` names one, following the revision and the
 * parts `ask` says. Another release opens its own, which replaces the last
 * one's on its first batch; the snapshot is only ever the current release's.
 */
export function useRelease(
  backend: Backend,
  release: ReleaseRef | undefined,
  ask: ReleaseAsk,
) {
  const key = release && JSON.stringify(release);
  const [live, setLive] = useState<{ key: string; view: ReleaseView }>();
  const asked = useRef(ask);
  const { revision, parts } = ask;
  const { overview, values, manifest, history } = parts;
  useEffect(() => {
    asked.current = {
      revision,
      parts: { overview, values, manifest, history },
    };
  }, [revision, overview, values, manifest, history]);
  useEffect(() => {
    if (key === undefined) return;
    const view = new ReleaseView(
      backend,
      JSON.parse(key) as ReleaseRef,
      asked.current,
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
  }, [backend, key]);
  const current = live?.key === key ? live?.view : undefined;
  useEffect(() => {
    current?.setAsk({
      revision,
      parts: { overview, values, manifest, history },
    });
  }, [current, revision, overview, values, manifest, history]);
  const snapshot = useSyncExternalStore(
    current?.subscribe ?? NOTHING,
    current?.getSnapshot ?? INITIAL,
  );
  const id = useMemo(() => current && (() => current.id()), [current]);
  return { snapshot, id };
}

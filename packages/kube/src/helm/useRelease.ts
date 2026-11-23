import {
  INITIAL_RELEASE,
  ReleaseView,
  type Backend,
  type ReleaseAsk,
  type ReleaseRef,
} from "@twigo/protocol";
import { useOpenView } from "../object/useOpenView";

const open = (backend: Backend, release: ReleaseRef, ask: ReleaseAsk) =>
  new ReleaseView(backend, release, ask);
const INITIAL = () => INITIAL_RELEASE;

/** An open release while `release` names one, following the revision and the parts `ask` says. */
export function useRelease(
  backend: Backend,
  release: ReleaseRef | undefined,
  ask: ReleaseAsk,
) {
  const { snapshot, id } = useOpenView(backend, open, release, ask, INITIAL);
  return { snapshot, id };
}

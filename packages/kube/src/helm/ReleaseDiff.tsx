import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { GitCompare } from "lucide-react";
import {
  toIpcError,
  type ComparedPart,
  type ComparedRevisions,
  type IpcError,
  type ReleaseRef,
} from "@twigo/protocol";
import { Banner, EmptyState, Skeleton, TabBar } from "@twigo/ui";
import { ErrorMessage, useWorkbench } from "@twigo/workbench";
import { yamlOfJson } from "../edit/object";

const DiffView = lazy(() => import("../edit/DiffView"));

const PARTS: readonly { value: ComparedPart; label: string }[] = [
  { value: "values", label: "Values" },
  { value: "defaults", label: "Defaults" },
  { value: "manifest", label: "Manifest" },
];

type Answer =
  | { readonly part: ComparedPart; readonly texts: ComparedRevisions }
  | { readonly part: ComparedPart; readonly error: IpcError };

/**
 * Two revisions of a release in the diff editor (ARCHITECTURE 4.3), their
 * values, the chart's defaults or their manifests, unchanged lines folded.
 * Rust masks both sides and compares the real values: a value that changed
 * reads `<12 bytes, changed>` on both, which says it changed and nothing more.
 */
export function ReleaseDiff({
  release,
  from,
  to,
  part: first,
}: {
  release: ReleaseRef;
  from: number;
  to: number;
  /** What it opens on. */
  part: ComparedPart;
}) {
  const { backend } = useWorkbench();
  const [part, setPart] = useState(first);
  const [answer, setAnswer] = useState<Answer>();
  useEffect(() => {
    let live = true;
    backend.invoke("helm_compare", { release, from, to, part }).then(
      (texts) => {
        if (live) setAnswer({ part, texts });
      },
      (error: unknown) => {
        if (live) setAnswer({ part, error: toIpcError(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [backend, release, from, to, part]);
  const shown = answer?.part === part ? answer : undefined;
  const texts = useMemo(
    () =>
      shown && "texts" in shown
        ? part === "manifest"
          ? shown.texts
          : {
              from: yamlOfJson(shown.texts.from),
              to: yamlOfJson(shown.texts.to),
            }
        : undefined,
    [shown, part],
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <Banner
        tone="info"
        icon={GitCompare}
        title={`${release.name} r${String(from)} and r${String(to)}`}
      >
        Values are hidden as their sizes, and a value that changed is marked:
        its size reads “changed” on both sides.
      </Banner>
      <TabBar
        label="What to compare"
        tabs={PARTS}
        value={part}
        onChange={setPart}
        className="w-full shadow-[inset_0_-1px_0_var(--border-subtle)]"
      />
      <div className="min-h-0 flex-1">
        {texts ? (
          <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
            <DiffView
              original={texts.from}
              modified={texts.to}
              collapseUnchanged
            />
          </Suspense>
        ) : shown && "error" in shown ? (
          <EmptyState icon={GitCompare} title="Nothing to compare">
            <ErrorMessage error={shown.error} />
          </EmptyState>
        ) : (
          <Skeleton className="m-3 h-4 w-1/2" />
        )}
      </div>
    </div>
  );
}

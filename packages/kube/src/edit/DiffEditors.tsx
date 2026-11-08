import { lazy, Suspense, useMemo } from "react";
import { GitCompare } from "lucide-react";
import { EmptyState, Banner, Skeleton } from "@twigo/ui";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { useResources, type Discovery } from "../discovery";
import { objectQuery, useObject } from "../object/useObject";
import { parseDiffUri, parseObjectUri } from "../uri";
import { EditActions } from "./actions";
import { PreviewPage } from "./answers";
import { yamlOfJson } from "./object";
import type { EditServices } from "./services";

const DiffView = lazy(() => import("./DiffView"));

export function DiffEditor({
  uri,
  edits,
  discovery,
}: EditorProps & { edits: EditServices; discovery: Discovery }) {
  const input = parseDiffUri(uri);
  if (!input) {
    return <EmptyState title="Not a comparison">{uri}</EmptyState>;
  }
  switch (input.kind) {
    case "apply":
      return <ApplyDiff edits={edits} editor={input.editor} />;
    case "server":
      return <ServerDiff edits={edits} editor={input.editor} />;
    case "objects":
      return (
        <ObjectsDiff
          discovery={discovery}
          space={input.space}
          left={input.left}
          right={input.right}
        />
      );
  }
}

function ApplyDiff({ edits, editor }: { edits: EditServices; editor: string }) {
  useChanges(edits.previews.changes);
  useChanges(edits.copies.changes);
  return (
    <div className="h-full bg-editor">
      <PreviewPage
        edits={edits}
        uri={editor}
        preview={edits.previews.get(editor)}
        current={edits.copies.get(editor)?.text ?? ""}
      />
    </div>
  );
}

function ServerDiff({
  edits,
  editor,
}: {
  edits: EditServices;
  editor: string;
}) {
  useChanges(edits.copies.changes);
  const base = edits.copies.get(editor)?.base;
  const live = edits.copies.live(editor);
  const original = useMemo(
    () => (base === undefined ? undefined : yamlOfJson(base)),
    [base],
  );
  const modified = useMemo(
    () => (live === undefined ? undefined : yamlOfJson(live)),
    [live],
  );
  if (original === undefined || modified === undefined) {
    return (
      <EmptyState icon={GitCompare} title="Nothing to compare">
        The edit ended, so the object is no longer measured against what it was
        opened as.
      </EmptyState>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <Banner
        tone="info"
        icon={GitCompare}
        title="As you opened it, and on the server now"
        action={
          <EditActions edits={edits} uri={editor} menus={["edit/changed"]} />
        }
      />
      <div className="min-h-0 flex-1">
        <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
          <DiffView original={original} modified={modified} />
        </Suspense>
      </div>
    </div>
  );
}

function useManifest(
  discovery: Discovery,
  space: string,
  uri: string,
): string | undefined {
  const { backend } = useWorkbench();
  const resources = useResources(discovery, space);
  const input = parseObjectUri(uri);
  const { snapshot } = useObject(
    backend,
    input && objectQuery(input, resources),
    { overview: false, manifest: true, events: false, related: false },
  );
  return snapshot.manifest;
}

function ObjectsDiff({
  discovery,
  space,
  left,
  right,
}: {
  discovery: Discovery;
  space: string;
  left: string;
  right: string;
}) {
  const original = useManifest(discovery, space, left);
  const modified = useManifest(discovery, space, right);
  const names = [left, right].map((uri) => {
    const object = parseObjectUri(uri);
    return object
      ? `${object.namespace === undefined ? "" : `${object.namespace}/`}${object.name}`
      : uri;
  });
  const texts = useMemo(
    () =>
      original === undefined || modified === undefined
        ? undefined
        : { original: yamlOfJson(original), modified: yamlOfJson(modified) },
    [original, modified],
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <Banner tone="info" icon={GitCompare} title={names.join(" and ")}>
        Both as they are on the server, followed while this is open.
      </Banner>
      <div className="min-h-0 flex-1">
        {texts ? (
          <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
            <DiffView original={texts.original} modified={texts.modified} />
          </Suspense>
        ) : (
          <Skeleton className="m-3 h-4 w-1/2" />
        )}
      </div>
    </div>
  );
}

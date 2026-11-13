import { lazy, Suspense, useEffect, useMemo } from "react";
import { GitCompare } from "lucide-react";
import { EmptyState, Banner, Skeleton } from "@twigo/ui";
import {
  useChanges,
  useEditorShown,
  useWorkbench,
  type EditorProps,
} from "@twigo/workbench";
import {
  hasStatusSubresource,
  useResources,
  type Discovery,
} from "../discovery";
import { objectQuery, useObject } from "../object/useObject";
import { parseDiffUri, parseObjectUri } from "../uri";
import { objectProblem } from "../viewProblem";
import { EditActions } from "./actions";
import { PreviewPage } from "./answers";
import { kindOf, SECRET_NOTE, yamlOfJson } from "./object";
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
      return <ApplyDiff edits={edits} editor={input.editor} uri={uri} />;
    case "server":
      return (
        <ServerDiff edits={edits} discovery={discovery} editor={input.editor} />
      );
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

function ApplyDiff({
  edits,
  editor,
  uri,
}: {
  edits: EditServices;
  editor: string;
  uri: string;
}) {
  const { editors } = useWorkbench();
  useChanges(edits.previews.changes);
  useChanges(edits.copies.changes);
  useChanges(editors.changes);
  const preview = edits.previews.get(editor);
  const shown = useEditorShown();
  // An answer that came while its space was away, or its tab was under a maximized panel, is shown once its tab is on screen.
  const onScreen =
    shown && editors.active === uri && preview?.state === "answered";
  useEffect(() => {
    if (onScreen) edits.previews.shown(editor);
  }, [edits.previews, editor, onScreen]);
  return (
    <div className="h-full bg-editor">
      <PreviewPage
        edits={edits}
        uri={editor}
        preview={preview}
        current={edits.copies.get(editor)?.text ?? ""}
      />
    </div>
  );
}

function isSecret(manifest: string | undefined): boolean {
  return (
    manifest !== undefined && kindOf(JSON.parse(manifest))?.kind === "Secret"
  );
}

/** The object as it is on the server, followed for as long as the diff is open, and why not when it cannot be. */
function useManifest(discovery: Discovery, space: string, uri: string) {
  const { backend } = useWorkbench();
  const resources = useResources(discovery, space);
  const input = parseObjectUri(uri);
  const { snapshot } = useObject(
    backend,
    input && objectQuery(input, resources),
    {
      overview: false,
      manifest: true,
      events: false,
      related: false,
      usage: false,
    },
  );
  return {
    manifest: snapshot.manifest,
    problem: objectProblem(snapshot),
    statusSubresource: hasStatusSubresource(resources, input?.gvr),
  };
}

function ServerDiff({
  edits,
  discovery,
  editor,
}: {
  edits: EditServices;
  discovery: Discovery;
  editor: string;
}) {
  useChanges(edits.copies.changes);
  const base = edits.copies.get(editor)?.base;
  const {
    manifest: live,
    problem,
    statusSubresource,
  } = useManifest(discovery, parseObjectUri(editor)?.space ?? "", editor);
  // Keep mine locks to what the working copy last saw, which is what this shows.
  useEffect(() => {
    if (live !== undefined) {
      edits.copies.see(editor, live, statusSubresource);
    }
  }, [edits.copies, editor, live, statusSubresource]);
  const original = useMemo(
    () => (base === undefined ? undefined : yamlOfJson(base)),
    [base],
  );
  const modified = useMemo(
    () => (live === undefined ? undefined : yamlOfJson(live)),
    [live],
  );
  if (original === undefined) {
    return (
      <EmptyState icon={GitCompare} title="Nothing to compare">
        The edit ended, so the object is no longer measured against what it was
        opened as.
      </EmptyState>
    );
  }
  if (modified === undefined) {
    return problem ? (
      <EmptyState icon={problem.icon} title={problem.title}>
        {problem.body}
      </EmptyState>
    ) : (
      <Skeleton className="m-3 h-4 w-1/2" />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <Banner
        tone="info"
        icon={GitCompare}
        title="As you opened it, and on the server now"
        action={
          <EditActions edits={edits} uri={editor} menus={["edit/server"]} />
        }
      >
        {isSecret(base) && SECRET_NOTE}
      </Banner>
      <div className="min-h-0 flex-1">
        <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
          <DiffView original={original} modified={modified} />
        </Suspense>
      </div>
    </div>
  );
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
      original.manifest === undefined || modified.manifest === undefined
        ? undefined
        : {
            original: yamlOfJson(original.manifest),
            modified: yamlOfJson(modified.manifest),
          },
    [original.manifest, modified.manifest],
  );
  const missing = [original.problem, modified.problem].flatMap(
    (problem, side) =>
      problem && names[side] !== undefined
        ? [`${names[side]}: ${problem.title}. ${problem.body}`]
        : [],
  );
  return (
    <div className="flex h-full min-h-0 flex-col bg-editor">
      <Banner tone="info" icon={GitCompare} title={names.join(" and ")}>
        {texts &&
          `Both as they are on the server, followed while this is open.${isSecret(original.manifest) || isSecret(modified.manifest) ? ` ${SECRET_NOTE}` : ""}`}
      </Banner>
      <div className="min-h-0 flex-1">
        {texts ? (
          <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
            <DiffView original={texts.original} modified={texts.modified} />
          </Suspense>
        ) : missing.length > 0 ? (
          <EmptyState icon={GitCompare} title="Nothing to compare">
            {missing.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </EmptyState>
        ) : (
          <Skeleton className="m-3 h-4 w-1/2" />
        )}
      </div>
    </div>
  );
}

import { lazy, Suspense, useEffect, useMemo } from "react";
import { TriangleAlert } from "lucide-react";
import { Banner, Skeleton } from "@twigo/ui";
import { useChanges } from "@twigo/workbench";
import { EditActions } from "./actions";
import { AnswerView, FailedBar } from "./answers";
import { placementOf } from "./placement";
import type { SchemaKind } from "./schemas";
import type { EditServices } from "./services";

const YamlEditor = lazy(() => import("./YamlEditor"));

/**
 * An editor's YAML with what surrounds it (ARCHITECTURE 4.3, 6.5): its
 * toolbar, the bar that says the object changed on the server, and the
 * answers of the dry run that fit a bar. An object's tab and a new manifest
 * share it; the text and where it goes are theirs.
 */
export function YamlSurface({
  edits,
  uri,
  space,
  text,
  onChange,
  statusLocked,
  schemaKind,
  note,
}: {
  edits: EditServices;
  uri: string;
  space: string | undefined;
  text: string;
  onChange: (text: string) => void;
  statusLocked: boolean;
  schemaKind: Omit<SchemaKind, "space"> | undefined;
  note: string;
}) {
  useChanges(edits.copies.changes);
  useChanges(edits.previews.changes);
  useChanges(edits.schemas.changes);
  const dirty = edits.copies.get(uri) !== undefined;
  const { group, version, kind } = schemaKind ?? {};
  const asked = useMemo(
    () =>
      space !== undefined &&
      group !== undefined &&
      version !== undefined &&
      kind !== undefined
        ? { space, group, version, kind }
        : undefined,
    [space, group, version, kind],
  );
  useEffect(() => {
    if (dirty && asked) edits.schemas.ensure(asked);
  }, [edits.schemas, dirty, asked]);
  const loaded = asked && edits.schemas.get(asked);
  const schema = useMemo(
    () =>
      loaded?.state === "ready" && asked
        ? {
            source: `twigo://schema/${asked.group}/${asked.version}/${asked.kind}`,
            schema: loaded.schema,
          }
        : undefined,
    [loaded, asked],
  );

  const preview = edits.previews.get(uri);
  const failed = preview?.state === "failed" ? preview : undefined;
  const error = useMemo(
    () => (failed?.at ? { message: failed.message, ...failed.at } : undefined),
    [failed],
  );
  const answered = preview?.state === "answered" ? preview : undefined;
  const barred =
    answered !== undefined && placementOf(answered.answer) === "bar";
  const changed = edits.copies.serverChanged(uri);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-8 flex-none items-center gap-2 border-b border-border-subtle pr-2 pl-3 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {note}
          {loaded?.state === "failed" && (
            <span title={loaded.message}> · No schema for completion</span>
          )}
        </span>
        <EditActions edits={edits} uri={uri} menus={["edit/toolbar"]} />
      </div>
      {changed && (
        <Banner
          tone="warn"
          icon={TriangleAlert}
          title="Changed on server"
          action={
            <EditActions edits={edits} uri={uri} menus={["edit/changed"]} />
          }
        >
          The object changed after you opened it.
        </Banner>
      )}
      {failed && <FailedBar failure={failed} />}
      {answered && barred && (
        <AnswerView
          edits={edits}
          uri={uri}
          answer={answered.answer}
          space={answered.subject.space}
          outdated={answered.subject.text !== text}
        />
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
          <YamlEditor
            uri={uri}
            text={text}
            onChange={onChange}
            statusLocked={statusLocked}
            {...(schema && { schema })}
            {...(error && { error })}
          />
        </Suspense>
      </div>
    </div>
  );
}

import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { CircleAlert, GitCompare, Info, Lock } from "lucide-react";
import type { ApplyPreviewed } from "@twigo/protocol";
import { Banner, Callout, EmptyState, Skeleton, Table } from "@twigo/ui";
import {
  accessOfSpace,
  chipLabel,
  useChanges,
  useWorkbench,
} from "@twigo/workbench";
import { yamlOfObject } from "./object";
import type { Failure, Preview } from "./previews";
import type { EditServices } from "./services";
import { EditActions } from "./actions";

const DiffView = lazy(() => import("./DiffView"));

export function AnswerView({
  edits,
  uri,
  answer,
  dropped,
  space,
  outdated,
}: {
  edits: EditServices;
  uri: string;
  answer: ApplyPreviewed;
  dropped: readonly string[];
  space: string;
  /** The text changed since the preview, so its plan would send the old one. */
  outdated: boolean;
}) {
  switch (answer.state) {
    case "unchanged":
      return (
        <Unchanged
          edits={edits}
          uri={uri}
          ignored={answer.ignored}
          dropped={dropped}
        />
      );
    case "ready":
      return (
        <Ready
          edits={edits}
          uri={uri}
          answer={answer}
          space={space}
          outdated={outdated}
        />
      );
    case "conflicts":
      return <Conflicts edits={edits} uri={uri} answer={answer} />;
    case "stale":
      return (
        <Stale
          edits={edits}
          uri={uri}
          message={answer.message}
          keepable={answer.keepable}
        />
      );
    case "immutable":
      return (
        <Immutable
          edits={edits}
          uri={uri}
          message={answer.message}
          recreates={answer.recreate !== null}
        />
      );
  }
}

export function FailedBar({ failure }: { failure: Failure }) {
  return (
    <Banner
      tone="error"
      icon={CircleAlert}
      title={
        failure.at
          ? `Line ${String(failure.at.line)}, column ${String(failure.at.column)}`
          : "Cannot apply"
      }
    >
      {failure.message}
    </Banner>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="flex-none border-b border-border-subtle p-2">
      {children}
    </div>
  );
}

function Unchanged({
  edits,
  uri,
  ignored,
  dropped,
}: {
  edits: EditServices;
  uri: string;
  ignored: readonly string[];
  dropped: readonly string[];
}) {
  return (
    <Banner
      tone="info"
      icon={Info}
      title="Nothing to apply"
      action={<EditActions edits={edits} uri={uri} menus={["edit/answer"]} />}
    >
      {dropped.length > 0
        ? `Nothing is left to send once ${dropped.join(", ")} ${dropped.length === 1 ? "is" : "are"} out of it. Your YAML still holds your ${dropped.length === 1 ? "value" : "values"}.`
        : "The YAML says what the object has now."}
      {ignored.length > 0 && ` Left out: ${ignored.join(", ")}.`}
    </Banner>
  );
}

function Conflicts({
  edits,
  uri,
  answer,
}: {
  edits: EditServices;
  uri: string;
  answer: Extract<ApplyPreviewed, { state: "conflicts" }>;
}) {
  const count = answer.conflicts.length;
  return (
    <Panel>
      <Callout
        tone="warn"
        title={`Other managers own ${String(count)} of the fields you changed`}
      >
        <Table
          label="Conflicting fields"
          columns={["Field", "Owned by"]}
          rows={answer.conflicts.map(({ path, manager }) => [
            <code key={path}>{path}</code>,
            manager,
          ])}
        />
        <p className="text-xs text-muted-foreground">
          Force takes the fields from their owners. Drop my change leaves them
          out of what is sent: your YAML keeps your values until the apply
          lands, and then shows what the server holds.
        </p>
        <EditActions
          edits={edits}
          uri={uri}
          menus={["edit/conflicts", "edit/answer"]}
        />
      </Callout>
    </Panel>
  );
}

function Stale({
  edits,
  uri,
  message,
  keepable,
}: {
  edits: EditServices;
  uri: string;
  message: string;
  keepable: boolean;
}) {
  return (
    <Panel>
      <Callout tone="warn" title="Changed on the server since you opened it">
        <p>{message}</p>
        <p className="text-xs text-muted-foreground">
          {keepable &&
            "Keep mine applies your changes on top of the new version. "}
          Reload takes the server&apos;s and drops yours.
        </p>
        <EditActions
          edits={edits}
          uri={uri}
          menus={["edit/changed", "edit/answer"]}
        />
      </Callout>
    </Panel>
  );
}

function Immutable({
  edits,
  uri,
  message,
  recreates,
}: {
  edits: EditServices;
  uri: string;
  message: string;
  recreates: boolean;
}) {
  return (
    <Panel>
      <Callout tone="error" title="The server refuses to change that field">
        <p>{message}</p>
        {recreates && (
          <p className="text-xs text-muted-foreground">
            Delete and recreate deletes the object and creates it from your
            YAML. Twigo asks before it does.
          </p>
        )}
        <EditActions
          edits={edits}
          uri={uri}
          menus={["edit/immutable", "edit/answer"]}
        />
      </Callout>
    </Panel>
  );
}

function Ready({
  edits,
  uri,
  answer,
  space,
  outdated,
}: {
  edits: EditServices;
  uri: string;
  answer: Extract<ApplyPreviewed, { state: "ready" }>;
  space: string;
  outdated: boolean;
}) {
  const workbench = useWorkbench();
  useChanges(workbench.catalog.changes);
  useChanges(workbench.spaces.changes);
  const found = workbench.spaces.list.find(({ id }) => id === space);
  const access = found && accessOfSpace(workbench.catalog, found);
  const lock = access?.mode === "read-only" ? chipLabel(access) : undefined;
  const live = useMemo(
    () => (answer.live === null ? "" : yamlOfObject(answer.live)),
    [answer.live],
  );
  const result = useMemo(() => yamlOfObject(answer.result), [answer.result]);
  const { warnings, removals, ignored, strategy } = answer;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {lock !== undefined && (
        <Banner tone="info" icon={Lock} title={lock}>
          The dry run and this diff work. Apply is refused until the context is
          unlocked.
        </Banner>
      )}
      {outdated && (
        <Banner
          tone="warn"
          icon={CircleAlert}
          title="The YAML changed after this preview"
        >
          Apply again to see the diff of the text as it is now.
        </Banner>
      )}
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-1.5 text-xs">
        <span className="font-medium">
          {answer.live === null ? "Not on the cluster yet" : "Live"}
        </span>
        <span className="text-muted-foreground">against</span>
        <span className="font-medium">the result of the dry run</span>
        <span className="text-muted-foreground">on</span>
        <span className="font-medium">{found?.name ?? space}</span>
        <span className="flex-1" />
        <EditActions edits={edits} uri={uri} menus={["edit/diff"]} />
      </div>
      {(warnings.length > 0 ||
        removals.length > 0 ||
        ignored.length > 0 ||
        strategy === "mergePatch") && (
        <div className="flex flex-none flex-col gap-1.5 border-b border-border-subtle px-3 py-2 text-xs">
          {warnings.length > 0 && (
            <Callout tone="warn" title="The server warns">
              <ul className="list-disc pl-4">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Callout>
          )}
          {strategy === "mergePatch" && (
            <p>
              <span className="font-medium">One merge patch.</span> A
              server-side apply cannot express this edit without owning fields
              you did not change, so it goes as a single JSON merge patch under
              the field manager twigo-edit, as kubectl edit sends it.
            </p>
          )}
          {removals.length > 0 && (
            <p>
              <span className="font-medium">
                {strategy === "mergePatch"
                  ? "Removed by the patch: "
                  : "A separate step removes: "}
              </span>
              {removals.map((field, index) => (
                <span key={field}>
                  {index > 0 && ", "}
                  <code>{field}</code>
                </span>
              ))}
              {strategy === "serverSideApply" &&
                ". Fields no one else owns go with the apply; these stay after one, so a merge patch with null follows it."}
            </p>
          )}
          {ignored.length > 0 && (
            <p className="text-muted-foreground">
              Left out of what is sent:{" "}
              {ignored.map((field, index) => (
                <span key={field}>
                  {index > 0 && ", "}
                  <code>{field}</code>
                </span>
              ))}
              .
            </p>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
          <DiffView original={live} modified={result} />
        </Suspense>
      </div>
    </div>
  );
}

export function PreviewPage({
  edits,
  uri,
  preview,
  current,
}: {
  edits: EditServices;
  uri: string;
  preview: Preview | undefined;
  current: string;
}) {
  if (preview === undefined) {
    return (
      <EmptyState icon={GitCompare} title="Nothing is being previewed">
        Apply the edit to see its diff.
      </EmptyState>
    );
  }
  switch (preview.state) {
    case "running":
      return <Skeleton className="m-3 h-4 w-1/2" />;
    case "failed":
      return <FailedBar failure={preview} />;
    case "answered":
      return (
        <AnswerView
          edits={edits}
          uri={uri}
          answer={preview.answer}
          dropped={preview.dropped}
          space={preview.subject.space}
          outdated={preview.subject.text !== current}
        />
      );
  }
}

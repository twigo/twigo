import { lazy, Suspense, useMemo } from "react";
import type { ApprovalDetail } from "@twigo/protocol";
import { Callout, PropertyList, Skeleton } from "@twigo/ui";
import { yamlOfObject } from "../edit/object";
import {
  commandLine,
  inputWords,
  noDiffWords,
  propagationWords,
} from "./words";

const DiffView = lazy(() => import("../edit/DiffView"));

const CODE = "font-mono text-[11px] wrap-anywhere select-text";

export function RequestDetail({
  detail,
  folded,
}: {
  detail: ApprovalDetail;
  /** @todo: drop with the variants of the checkpoint, once the owner has chosen. */
  folded: boolean;
}) {
  switch (detail.kind) {
    case "diff":
      return <Changes {...detail} folded={folded} />;
    case "session":
      return (
        <PropertyList
          items={[
            {
              key: "runs",
              label: "Runs",
              value:
                detail.command.length === 0 ? (
                  "The process the container already runs."
                ) : (
                  <code className={CODE}>{commandLine(detail.command)}</code>
                ),
            },
            {
              key: "container",
              label: "In",
              value: detail.container ?? "The pod's default container.",
            },
            {
              key: "input",
              label: "Takes",
              value: inputWords(detail.tty, detail.stdin),
            },
          ]}
        />
      );
    case "delete":
      return <p>{propagationWords(detail.propagation)}</p>;
    case "unknown":
      return (
        <div className="grid gap-1.5">
          <p>Twigo cannot show what this changes.</p>
          {noDiffWords(detail.reason).map((sentence) => (
            <p key={sentence} className="text-muted-foreground">
              {sentence}
            </p>
          ))}
          {detail.body !== null && (
            <section aria-label="Request body" className="grid gap-1">
              <h3 className="text-[11px] font-semibold text-muted-foreground">
                Request body
              </h3>
              <pre
                className={`${CODE} max-h-32 overflow-y-auto rounded-md bg-row-active px-2 py-1.5 whitespace-pre-wrap`}
              >
                {detail.body}
              </pre>
            </section>
          )}
        </div>
      );
  }
}

function Changes({
  live,
  result,
  warnings,
  folded,
}: {
  live: unknown;
  result: unknown;
  warnings: readonly string[];
  folded: boolean;
}) {
  const before = useMemo(
    () => (live === null ? "" : yamlOfObject(live)),
    [live],
  );
  const after = useMemo(() => yamlOfObject(result), [result]);
  return (
    <div className="grid gap-2">
      {warnings.length > 0 && (
        <Callout tone="warn" title="The server warns">
          <ul className="list-disc pl-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </Callout>
      )}
      {!folded && (
        <>
          <p>
            <span className="font-medium">
              {live === null ? "Not on the cluster yet" : "Live"}
            </span>{" "}
            <span className="text-muted-foreground">against</span>{" "}
            <span className="font-medium">the result of a dry run</span>
          </p>
          <div
            role="group"
            aria-label="Changes"
            className="h-[300px] overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--border)]"
          >
            <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
              <DiffView collapseUnchanged original={before} modified={after} />
            </Suspense>
          </div>
        </>
      )}
    </div>
  );
}

import { lazy, Suspense, useMemo } from "react";
import type { ApprovalDetail } from "@twigo/protocol";
import { Callout, PropertyList, Skeleton } from "@twigo/ui";
import { kindOf, SECRET_NOTE, yamlOfObject } from "../edit/object";
import {
  commandLine,
  inputWords,
  noDiffWords,
  propagationWords,
} from "./words";

const DiffView = lazy(() => import("../edit/DiffView"));

const DIFF_HEIGHT = 300;

const CODE = "font-mono text-[11px] wrap-anywhere select-text";

export function RequestDetail({ detail }: { detail: ApprovalDetail }) {
  switch (detail.kind) {
    case "diff":
      return <Changes {...detail} />;
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
}: {
  live: unknown;
  result: unknown;
  warnings: readonly string[];
}) {
  const before = useMemo(
    () => (live === null ? "" : yamlOfObject(live)),
    [live],
  );
  const after = useMemo(() => yamlOfObject(result), [result]);
  const secret = [live, result].some(
    (object) => kindOf(object)?.kind === "Secret",
  );
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
      <p>
        <span className="font-medium">
          {live === null ? "Not on the cluster yet" : "Live"}
        </span>{" "}
        <span className="text-muted-foreground">against</span>{" "}
        <span className="font-medium">the result of a dry run</span>
      </p>
      {secret && <p className="text-muted-foreground">{SECRET_NOTE}</p>}
      <div
        role="group"
        aria-label="Changes"
        data-owns-escape
        className="overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--border)]"
      >
        <Suspense fallback={<Skeleton className="m-3 h-4 w-1/2" />}>
          <DiffView
            collapseUnchanged
            maxHeight={DIFF_HEIGHT}
            original={before}
            modified={after}
          />
        </Suspense>
      </div>
    </div>
  );
}

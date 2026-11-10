import type { ApprovalAnswer, ApprovalAsk } from "@twigo/protocol";
import {
  ConfirmDialog,
  PropertyList,
  type ConfirmChoice,
  type Property,
} from "@twigo/ui";
import { ContextBadge } from "../operations/ContextBadge";
import { contextAccent } from "../spaces/colors";
import { useChanges, useReturnFocus, useWorkbench } from "../react";
import { describeAsk } from "./service";

const MONO = "font-mono text-[11px] wrap-anywhere select-text";

/**
 * The dialog of the ask a process makes (ARCHITECTURE 6.4), one at a time
 * in the order they came and saying how many wait, in its context's colour
 * as a plan's dialog has it. Deny is what Escape does, and focus starts on
 * it, or on the typed name, so a stray Enter allows nothing. An ask waits
 * while a plan's confirmation is open, so it takes neither that dialog's
 * focus nor its Escape, and it shows once that dialog is gone.
 */
export function ApprovalHost() {
  const { approvals, operations } = useWorkbench();
  useChanges(approvals.changes);
  useChanges(operations.changes);
  const ask = operations.asking === undefined ? approvals.current : undefined;
  const returnFocus = useReturnFocus(ask !== undefined);
  if (!ask) return null;
  return (
    <AskDialog
      key={ask.id}
      ask={ask}
      waiting={approvals.asks.length}
      onCloseAutoFocus={returnFocus}
    />
  );
}

function AskDialog({
  ask,
  waiting,
  onCloseAutoFocus,
}: {
  ask: ApprovalAsk;
  waiting: number;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { approvals, catalog, colors } = useWorkbench();
  useChanges(approvals.changes);
  useChanges(catalog.changes);
  useChanges(colors.changes);
  const { details, failure, answering } = approvals;

  const access = catalog.find(ask.context)?.access;
  const environment = access?.environment ?? null;
  const answer = (given: ApprovalAnswer) => (typed: string | undefined) => {
    void approvals.answer(given, typed);
  };

  const minutes = ask.lastingMinutes;
  const choices: ConfirmChoice[] = [
    {
      label: ask.typed ? `Allow ${ask.verb}` : "Allow once",
      destructive: ask.typed,
      onSelect: answer("once"),
    },
    ...(minutes === null
      ? []
      : [
          {
            label: `Allow for ${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}`,
            onSelect: answer("lasting"),
          },
        ]),
  ];

  const claims: Property[] = [
    ...(ask.command === null
      ? []
      : [
          {
            key: "command",
            label: "The client says it runs",
            value: <code className={MONO}>{ask.command}</code>,
          },
        ]),
    ...(ask.impersonate === null
      ? []
      : [
          {
            key: "as",
            label: "Acting as",
            value: <code className={MONO}>{ask.impersonate}</code>,
          },
        ]),
  ];

  return (
    <ConfirmDialog
      badge={
        <>
          <ContextBadge
            context={ask.context}
            environment={environment}
            mode={access?.mode ?? "read-write"}
          />
          {waiting > 1 && (
            <span className="ml-auto text-muted-foreground tabular-nums">
              1 of {waiting}
            </span>
          )}
        </>
      }
      {...(environment === "production" && {
        accent: contextAccent(colors.of(ask.context)),
      })}
      question={`Allow ${ask.process} to ${describeAsk(ask)}?`}
      consequences={[]}
      {...(ask.typed && { typed: ask.context })}
      {...(failure !== undefined && { error: failure })}
      wide={details?.wide(ask.detail) ?? false}
      busy={answering}
      cancel="Deny"
      choices={choices}
      onCancel={() => {
        answer("deny")(undefined);
      }}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {claims.length > 0 && <PropertyList items={claims} />}
      {details && <details.component detail={ask.detail} />}
    </ConfirmDialog>
  );
}

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ApprovalAnswer, ApprovalAsk } from "@twigo/protocol";
import {
  Button,
  ConfirmDialog,
  PropertyList,
  type ConfirmChoice,
  type Property,
} from "@twigo/ui";
import { ContextBadge } from "../operations/ContextBadge";
import { contextAccent } from "../spaces/colors";
import { useChanges, useReturnFocus, useWorkbench } from "../react";
import { describeAsk } from "./service";
import { variant } from "./variant";

const MONO = "font-mono text-[11px] wrap-anywhere select-text";

/**
 * The dialog of the ask a process makes (ARCHITECTURE 6.4), one at a time
 * in the order they came and saying how many wait, in its context's colour
 * as a plan's dialog has it. Deny is what Escape does, and focus starts on
 * it, or on the typed name, so a stray Enter allows nothing.
 */
export function ApprovalHost() {
  const { approvals } = useWorkbench();
  useChanges(approvals.changes);
  const ask = approvals.current;
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
  const [expanded, setExpanded] = useState(false);
  const [lasting, setLasting] = useState(false);
  const chosen = variant();

  const access = catalog.find(ask.context)?.access;
  const environment = access?.environment ?? null;
  const answer = (given: ApprovalAnswer) => (typed: string | undefined) => {
    void approvals.answer(given, typed);
  };

  const wide = details?.wide(ask.detail) ?? false;
  const collapsed = wide && chosen.diff === "collapsed";
  const minutes = ask.lastingMinutes;
  const allow = ask.typed ? `Allow ${ask.verb}` : "Allow once";

  const choices: ConfirmChoice[] =
    chosen.scope === "checkbox"
      ? [
          {
            label: ask.typed ? allow : "Allow",
            destructive: ask.typed,
            onSelect: (typed) => {
              answer(lasting && minutes !== null ? "lasting" : "once")(typed);
            },
          },
        ]
      : [
          { label: allow, destructive: ask.typed, onSelect: answer("once") },
          ...(minutes === null
            ? []
            : [
                {
                  label: `Allow for ${lengthOf(minutes)}`,
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
      wide={wide && (!collapsed || expanded)}
      busy={answering}
      cancel="Deny"
      choices={choices}
      onCancel={() => {
        answer("deny")(undefined);
      }}
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {claims.length > 0 && <PropertyList items={claims} />}
      {details && (
        <details.component
          detail={ask.detail}
          folded={collapsed && !expanded}
        />
      )}
      {collapsed && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="justify-self-start"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {expanded ? (
            <ChevronDown aria-hidden />
          ) : (
            <ChevronRight aria-hidden />
          )}
          {expanded ? "Hide changes" : "Show changes"}
        </Button>
      )}
      {chosen.scope === "checkbox" && minutes !== null && (
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="accent-brand"
            checked={lasting}
            onChange={(event) => {
              setLasting(event.target.checked);
            }}
          />
          Don&apos;t ask again for {lengthOf(minutes)}
        </label>
      )}
    </ConfirmDialog>
  );
}

function lengthOf(minutes: number): string {
  return `${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}`;
}

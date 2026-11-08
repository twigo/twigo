import type { CSSProperties } from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { ConfirmDialog } from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import { environmentLabel, modeLabel } from "../spaces/modes";

/**
 * The dialog of the plan the person is asked to confirm (ARCHITECTURE 6.4),
 * in its context's colour: the context's type and name first, a strip along
 * the top where the context is production.
 */
export function ConfirmHost() {
  const { operations, colors } = useWorkbench();
  useChanges(operations.changes);
  useChanges(colors.changes);
  const asking = operations.asking;
  if (!asking) return null;
  const { plan, look } = asking;
  const color = colors.of(plan.context);
  const accent = `var(--context-${color})`;
  const type =
    plan.environment === null ? undefined : environmentLabel(plan.environment);
  const label =
    type ?? (plan.mode === "read-write" ? undefined : modeLabel(plan.mode));
  const Icon = plan.mode === "guarded" ? ShieldAlert : Lock;
  const badge = (
    <>
      {label && (
        <span
          className="twigo-mode-chip flex h-5 items-center gap-1 rounded px-[7px] text-[11px] font-semibold"
          style={
            {
              "--twigo-context": accent,
              "--twigo-context-ink": `var(--context-${color}-ink)`,
            } as CSSProperties
          }
        >
          {plan.mode !== "read-write" && (
            <Icon aria-hidden className="size-3" />
          )}
          {label}
        </span>
      )}
      <span className="text-muted-foreground">{plan.context}</span>
    </>
  );
  return (
    <ConfirmDialog
      key={plan.id}
      badge={badge}
      {...(plan.environment === "production" && { accent })}
      question={plan.question}
      consequences={plan.consequences}
      lists={plan.affected.map(({ title, objects }) => ({
        title,
        items: objects.map((object) => ({
          key: `${object.group}/${object.kind}/${object.namespace ?? ""}/${object.name}`,
          kind: object.kind,
          name: object.name,
          ...(object.namespace !== null && { detail: object.namespace }),
        })),
      }))}
      command={plan.kubectl}
      {...(plan.friction.kind === "typed" && { typed: plan.friction.text })}
      confirm={plan.confirm}
      icon={look.icon}
      destructive={plan.destructive}
      onConfirm={asking.confirm}
      onCancel={asking.cancel}
    />
  );
}

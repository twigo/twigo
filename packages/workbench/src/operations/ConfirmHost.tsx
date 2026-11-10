import { ConfirmDialog } from "@twigo/ui";
import { useChanges, useReturnFocus, useWorkbench } from "../react";
import { contextAccent } from "../spaces/colors";
import { ContextBadge } from "./ContextBadge";

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
  const returnFocus = useReturnFocus(asking !== undefined);
  if (!asking) return null;
  const { plan, look } = asking;
  const accent = contextAccent(colors.of(plan.context));
  return (
    <ConfirmDialog
      key={plan.id}
      badge={
        <ContextBadge
          context={plan.context}
          environment={plan.environment}
          mode={plan.mode}
        />
      }
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
      choices={[
        {
          label: plan.confirm,
          icon: look.icon,
          destructive: plan.destructive,
          onSelect: asking.confirm,
        },
      ]}
      onCancel={asking.cancel}
      onCloseAutoFocus={returnFocus}
    />
  );
}

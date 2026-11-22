import { ConfirmDialog } from "@twigo/ui";
import { useChanges, useReturnFocus, useWorkbench } from "../react";
import { contextAccent } from "../spaces/colors";
import { ContextBadge } from "./ContextBadge";
import { environmentChoices, environmentLines } from "./environmentChoices";

/**
 * The dialog of the plan the person is asked to confirm (ARCHITECTURE 6.4),
 * in its context's colour: the context's type and name first, a strip along
 * the top where the context is production. Where a command met a context
 * nobody marked, the dialog that asks what it is comes first.
 */
export function ConfirmHost() {
  const { operations, colors } = useWorkbench();
  useChanges(operations.changes);
  useChanges(colors.changes);
  const { asking, marking } = operations;
  const returnFocus = useReturnFocus(
    asking !== undefined || marking !== undefined,
  );
  if (!asking) {
    return marking ? (
      <ConfirmDialog
        key={marking.context}
        badge={
          <ContextBadge
            context={marking.context}
            environment={null}
            mode="guarded"
            unmarked
          />
        }
        question={`What is ${marking.context}?`}
        consequences={[
          "Nobody has said, so Twigo asks before a change or an exec on it. Its type sets how it asks.",
          ...environmentLines(),
        ]}
        choices={environmentChoices(marking.choose)}
        onCancel={marking.cancel}
        onCloseAutoFocus={returnFocus}
      />
    ) : null;
  }
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
      {...(plan.commandLine !== null && { command: plan.commandLine })}
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

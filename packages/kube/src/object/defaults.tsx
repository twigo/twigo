import type { ReactNode } from "react";
import type { Field, ObjectRef } from "@twigo/protocol";
import { Chip } from "@twigo/ui";
import { ValueView } from "./values";

/** A field's value; one that holds the cluster's default is drawn in the support role, tagged. */
export function FieldValue({
  field,
  onOpen,
}: {
  field: Field;
  onOpen: (target: ObjectRef) => void;
}): ReactNode {
  const value = <ValueView value={field.value} onOpen={onOpen} />;
  return field.default ? (
    <span className="text-support">
      {value}
      <Chip className="ml-1.5 text-2xs">default</Chip>
    </span>
  ) : (
    value
  );
}

/** The quiet link at the end of a part that holds its defaults: `5 defaults` while they are hidden, `Hide defaults` once shown. */
export function DefaultsLink({
  count,
  revealed,
  onToggle,
}: {
  count: number;
  revealed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={revealed}
      onClick={onToggle}
      className="self-start rounded-sm text-xs text-quiet outline-none hover:text-content focus-visible:shadow-[var(--focus-ring)]"
    >
      {revealed
        ? "Hide defaults"
        : `${count} ${count === 1 ? "default" : "defaults"}`}
    </button>
  );
}

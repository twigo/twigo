import type { ReactNode } from "react";
import type { Field, ObjectRef } from "@twigo/protocol";
import { Chip, PropertyList, type Property } from "@twigo/ui";
import { rowOf } from "./stacking";
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
    <span className="flex flex-wrap items-baseline gap-x-1.5 text-support">
      {value}
      <Chip className="text-2xs">default</Chip>
    </span>
  ) : (
    value
  );
}

export function Fields({
  fields,
  extra = [],
  onOpen,
  columns = 1,
  mono = false,
  cut = false,
}: {
  fields: readonly Field[];
  extra?: readonly Property[];
  onOpen: (target: ObjectRef) => void;
  columns?: 1 | 2;
  mono?: boolean;
  cut?: boolean;
}) {
  return (
    <PropertyList
      cut={cut}
      columns={columns}
      items={[
        ...fields.map((field, index) => ({
          key: `${String(index)}/${field.label}`,
          label: mono ? (
            <span className="font-mono text-xs">{field.label}</span>
          ) : (
            field.label
          ),
          copyLabel: field.label,
          ...(cut && { title: field.label }),
          ...rowOf(field.value),
          value: <FieldValue field={field} onOpen={onOpen} />,
        })),
        ...extra,
      ]}
    />
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

import { useState } from "react";
import type {
  Container,
  ContainerRole,
  Field,
  ObjectRef,
} from "@twigo/protocol";
import { Card, Pill, PropertyList, Section } from "@twigo/ui";
import { TONE } from "./tone";
import { ValueView } from "./values";

const ROLE: Readonly<Record<ContainerRole, string | null>> = {
  init: "init",
  sidecar: "sidecar",
  regular: null,
  ephemeral: "ephemeral",
};

/**
 * A pod's containers, or a pod template's, as cards (ARCHITECTURE 4.3):
 * the name, its state and ports, the image with its tag, its state's
 * times and resources; the rest of what kubectl describe prints of it,
 * its environment and its mounts fold.
 */
export function Containers({
  containers,
  onOpen,
}: {
  containers: readonly Container[];
  onOpen: (target: ObjectRef) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {containers.map((container) => (
        <ContainerCard
          key={`${container.role}/${container.name}`}
          container={container}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function ContainerCard({
  container,
  onOpen,
}: {
  container: Container;
  onOpen: (target: ObjectRef) => void;
}) {
  const { name, role, image, state, ports, fields, details, env, mounts } =
    container;
  const tag = image.lastIndexOf(":");
  const slash = image.lastIndexOf("/");
  const [repository, version] =
    tag > slash ? [image.slice(0, tag + 1), image.slice(tag + 1)] : [image, ""];
  return (
    <Card>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">{name}</span>
        {ROLE[role] && (
          <span className="text-xs text-muted-foreground">{ROLE[role]}</span>
        )}
        {state && (
          <Pill tone={TONE[state.tone]} className="h-[18px] text-[11px]">
            {state.text}
          </Pill>
        )}
        {state && state.restarts > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {state.restarts === 1 ? "1 restart" : `${state.restarts} restarts`}
          </span>
        )}
        {ports.length > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">
            {ports.join(", ")}
          </span>
        )}
      </div>
      <code className="font-mono text-xs break-all text-muted-foreground">
        {repository}
        <span className="text-foreground">{version}</span>
      </code>
      {fields.length > 0 && <Fields fields={fields} onOpen={onOpen} />}
      <Folded title="Details" fields={details} onOpen={onOpen} />
      <Folded title="Environment" fields={env} onOpen={onOpen} />
      <Folded title="Mounts" fields={mounts} onOpen={onOpen} />
    </Card>
  );
}

function Fields({
  fields,
  onOpen,
  mono = false,
}: {
  fields: readonly Field[];
  onOpen: (target: ObjectRef) => void;
  mono?: boolean;
}) {
  return (
    <PropertyList
      items={fields.map((field, index) => ({
        key: `${index}/${field.label}`,
        label: mono ? (
          <span className="font-mono text-xs">{field.label}</span>
        ) : (
          field.label
        ),
        title: field.label,
        value: <ValueView value={field.value} onOpen={onOpen} />,
      }))}
    />
  );
}

/** A container's variables or mounts, by name, folded until opened. */
function Folded({
  title,
  fields,
  onOpen,
}: {
  title: string;
  fields: readonly Field[];
  onOpen: (target: ObjectRef) => void;
}) {
  const [open, setOpen] = useState(false);
  if (fields.length === 0) return null;
  return (
    <Section
      title={`${title} ${fields.length}`}
      open={open}
      onToggle={() => {
        setOpen(!open);
      }}
    >
      <Fields fields={fields} onOpen={onOpen} mono />
    </Section>
  );
}

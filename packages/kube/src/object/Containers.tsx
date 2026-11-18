import type {
  Container,
  ContainerRole,
  Field,
  ObjectRef,
} from "@twigo/protocol";
import { Card, Pill, PropertyList, Section } from "@twigo/ui";
import { useChanges } from "@twigo/workbench";
import type { OverviewStates } from "./overviewStates";
import { isNumeric } from "./numeric";
import { CONTAINER_GROUPS, containerGroup } from "./pageFilter";
import type { GroupFolds } from "./pageStates";
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
 * its environment and its mounts fold, and while the page's filter holds
 * text, a group it narrowed draws open.
 */
export function Containers({
  containers,
  states,
  kind,
  onOpen,
  groups,
}: {
  containers: readonly Container[];
  /** Where the folds are kept, for every object of `kind`. */
  states: OverviewStates;
  kind: string;
  onOpen: (target: ObjectRef) => void;
  groups: GroupFolds | undefined;
}) {
  useChanges(states.changes);
  return (
    <div className="flex flex-col gap-2">
      {containers.map((container) => (
        <ContainerCard
          key={`${container.role}/${container.name}`}
          container={container}
          fold={(title) => {
            const id = containerGroup(container.name, title);
            const normally = states.open(kind, id, false);
            const open = groups ? groups.open(id, normally) : normally;
            return {
              open,
              onToggle: () => {
                if (groups) groups.set(id, !open);
                else states.toggle(kind, id);
              },
            };
          }}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

/** Whether a folded part of a card is open, and how it toggles. */
type Fold = (title: string) => { open: boolean; onToggle: () => void };

function ContainerCard({
  container,
  fold,
  onOpen,
}: {
  container: Container;
  fold: Fold;
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
          <span className="text-xs text-support">{ROLE[role]}</span>
        )}
        {state && (
          <Pill tone={TONE[state.tone]} className="h-[18px] text-2xs">
            {state.text}
          </Pill>
        )}
        {state && state.restarts > 0 && (
          <span className="text-xs text-support tabular-nums">
            {state.restarts === 1 ? "1 restart" : `${state.restarts} restarts`}
          </span>
        )}
        {ports.length > 0 && (
          <span className="ml-auto text-xs text-support">
            {ports.join(", ")}
          </span>
        )}
      </div>
      <code className="font-mono text-xs break-all text-support">
        {repository}
        <span className="text-content">{version}</span>
      </code>
      {fields.length > 0 && <Fields fields={fields} onOpen={onOpen} />}
      <Folded
        title={CONTAINER_GROUPS.details}
        fields={details}
        fold={fold}
        onOpen={onOpen}
      />
      <Folded
        title={CONTAINER_GROUPS.env}
        fields={env}
        fold={fold}
        onOpen={onOpen}
        cut
      />
      <Folded
        title={CONTAINER_GROUPS.mounts}
        fields={mounts}
        fold={fold}
        onOpen={onOpen}
        cut
      />
    </Card>
  );
}

function Fields({
  fields,
  onOpen,
  mono = false,
  cut = false,
}: {
  fields: readonly Field[];
  onOpen: (target: ObjectRef) => void;
  mono?: boolean;
  cut?: boolean;
}) {
  return (
    <PropertyList
      cut={cut}
      items={fields.map((field, index) => ({
        key: `${index}/${field.label}`,
        label: mono ? (
          <span className="font-mono text-xs">{field.label}</span>
        ) : (
          field.label
        ),
        ...(cut && { title: field.label }),
        numeric: isNumeric(field.value),
        value: <ValueView value={field.value} onOpen={onOpen} />,
      }))}
    />
  );
}

/** A container's details, variables or mounts, folded until opened; `cut` for the keys and paths of variables and mounts. */
function Folded({
  title,
  fields,
  fold,
  onOpen,
  cut = false,
}: {
  title: string;
  fields: readonly Field[];
  fold: Fold;
  onOpen: (target: ObjectRef) => void;
  cut?: boolean;
}) {
  if (fields.length === 0) return null;
  const { open, onToggle } = fold(title);
  return (
    <Section
      title={`${title} ${fields.length}`}
      size="group"
      open={open}
      onToggle={onToggle}
    >
      <Fields fields={fields} onOpen={onOpen} mono cut={cut} />
    </Section>
  );
}

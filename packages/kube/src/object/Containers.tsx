import { Fragment, useId } from "react";
import type {
  Container,
  ContainerRole,
  Field,
  Measure,
  ObjectRef,
  ShownUsage,
} from "@twigo/protocol";
import { Card, CopyButton, Pill, PropertyList, type Property } from "@twigo/ui";
import { useChanges } from "@twigo/workbench";
import { DefaultsLink, FieldValue } from "./defaults";
import type { OverviewStates } from "./overviewStates";
import { isNumeric } from "./numeric";
import { CONTAINER_GROUPS, containerGroup, defaultsId } from "./pageFilter";
import type { GroupFolds } from "./pageStates";
import { TONE } from "./tone";
import { LABEL } from "./figures";
import { ContainerMeter, UsageNote } from "./Usage";
import { rowOf } from "./stacking";
import { ImageName } from "./values";

const ROLE: Readonly<Record<ContainerRole, string | null>> = {
  init: "init",
  sidecar: "sidecar",
  regular: null,
  ephemeral: "ephemeral",
};

/**
 * A pod's containers, or a pod template's, as cards (ARCHITECTURE 4.3):
 * the name, its state and ports, the image, its state's times, resources
 * and use; the rest of what kubectl describe prints of it, its details,
 * variables and mounts, is one line of counts whose groups open in place,
 * and while the page's filter holds text, a group it narrowed draws open. A
 * group's fields that hold the cluster's default hide behind a link at its
 * end, unless the filter narrowed the group.
 */
export function Containers({
  containers,
  states,
  kind,
  usage,
  onOpen,
  groups,
}: {
  containers: readonly Container[];
  /** Where the folds are kept, for every object of `kind`. */
  states: OverviewStates;
  kind: string;
  usage?: ShownUsage | undefined;
  onOpen: (target: ObjectRef) => void;
  groups: GroupFolds | undefined;
}) {
  useChanges(states.changes);
  return (
    <div className="flex flex-col gap-2">
      {usage &&
        usage.state !== "ready" &&
        containers.some(({ state }) => state?.running) && (
          <UsageNote state={usage.state} />
        )}
      {containers.map((container) => (
        <ContainerCard
          key={`${container.role}/${container.name}`}
          container={container}
          usage={usage}
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
              narrowed: groups?.narrowed(id) === true,
              revealed: states.open(kind, defaultsId(id), false),
              onReveal: () => {
                states.toggle(kind, defaultsId(id));
              },
            };
          }}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

const NOTHING: Measure = {
  used: null,
  request: null,
  limit: null,
  allocatable: null,
};

/**
 * The rows of a container's CPU and Memory: the figures of its own sample,
 * which a usage that waits for the first answer has not yet, and no data yet
 * for a running container that a ready answer does not name. A container
 * that is neither named nor running has none, nor has one in a context that
 * gives no figures, which `UsageNote` says.
 */
function meterRows(
  usage: ShownUsage | undefined,
  { name, state }: Container,
): Property[] {
  if (usage?.state !== "ready") return [];
  const named = usage.containers.find((each) => each.name === name);
  if (!named && !state?.running) return [];
  return (["cpu", "memory"] as const).map((resource) => ({
    key: `usage/${resource}`,
    label: LABEL[resource],
    value: (
      <ContainerMeter
        resource={resource}
        measure={named?.[resource] ?? NOTHING}
        waiting={usage.waiting}
        name={name}
      />
    ),
  }));
}

/** What a card's group is as the page draws it, and how the person changes it. */
interface GroupState {
  readonly open: boolean;
  readonly onToggle: () => void;
  /** The filter narrowed its rows, which all show, the defaults among them. */
  readonly narrowed: boolean;
  /** Its defaults show where they would hide behind their count. */
  readonly revealed: boolean;
  readonly onReveal: () => void;
}

type Fold = (title: string) => GroupState;

function ContainerCard({
  container,
  usage,
  fold,
  onOpen,
}: {
  container: Container;
  usage: ShownUsage | undefined;
  fold: Fold;
  onOpen: (target: ObjectRef) => void;
}) {
  const { name, role, image, state, ports, fields, details, env, mounts } =
    container;
  const meters = meterRows(usage, container);
  const groups = [
    {
      title: CONTAINER_GROUPS.details,
      label: "Details",
      fields: details,
      cut: false,
    },
    { title: CONTAINER_GROUPS.env, label: "Env", fields: env, cut: true },
    {
      title: CONTAINER_GROUPS.mounts,
      label: "Mounts",
      fields: mounts,
      cut: true,
    },
  ]
    .filter((group) => group.fields.length > 0)
    .map((group) => ({ ...group, state: fold(group.title) }));
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
      <div className="group/copy">
        <CopyButton text={image} label="Copy image" floated />
        <ImageName image={image} />
      </div>
      {(fields.length > 0 || meters.length > 0) && (
        <Fields fields={fields} extra={meters} onOpen={onOpen} />
      )}
      {groups.length > 0 && (
        <div className="-mx-1 flex flex-wrap items-center gap-x-0.5 text-xs">
          {groups.map(({ title, label, fields: group, state }, at) => (
            <Fragment key={title}>
              {at > 0 && (
                <span aria-hidden className="text-quiet">
                  ·
                </span>
              )}
              <button
                type="button"
                aria-expanded={state.open}
                onClick={state.onToggle}
                className="h-5 rounded-sm px-1 text-support outline-none hover:bg-row-hover hover:text-content focus-visible:shadow-[var(--focus-ring)] aria-expanded:bg-row-active aria-expanded:text-content"
              >
                {label} <span className="tabular-nums">{group.length}</span>
              </button>
            </Fragment>
          ))}
        </div>
      )}
      {groups.map(
        ({ title, fields: group, cut, state }) =>
          state.open && (
            <OpenGroup
              key={title}
              title={title}
              fields={group}
              cut={cut}
              state={state}
              onOpen={onOpen}
            />
          ),
      )}
    </Card>
  );
}

/**
 * An open group of a card, named by its caption, which a screen reader reads
 * once. Its fields that hold the cluster's default hide behind a link at its
 * end, unless the filter narrowed it, which shows the rows it kept.
 */
function OpenGroup({
  title,
  fields,
  cut,
  state: { narrowed, revealed, onReveal },
  onOpen,
}: {
  title: string;
  fields: readonly Field[];
  cut: boolean;
  state: GroupState;
  onOpen: (target: ObjectRef) => void;
}) {
  const caption = useId();
  const defaults = fields.filter((field) => field.default).length;
  const hidden = !narrowed && !revealed && defaults > 0;
  const shown = hidden ? fields.filter((field) => !field.default) : fields;
  return (
    <div role="group" aria-labelledby={caption} className="flex flex-col gap-1">
      <p id={caption} className="text-label font-semibold text-support">
        {title}
      </p>
      {shown.length > 0 && (
        <Fields fields={shown} onOpen={onOpen} mono cut={cut} />
      )}
      {!narrowed && defaults > 0 && (
        <DefaultsLink
          count={defaults}
          revealed={revealed}
          onToggle={onReveal}
        />
      )}
    </div>
  );
}

function Fields({
  fields,
  extra = [],
  onOpen,
  mono = false,
  cut = false,
}: {
  fields: readonly Field[];
  extra?: readonly Property[];
  onOpen: (target: ObjectRef) => void;
  mono?: boolean;
  cut?: boolean;
}) {
  return (
    <PropertyList
      cut={cut}
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
          numeric: isNumeric(field.value),
          ...rowOf(field.value),
          value: <FieldValue field={field} onOpen={onOpen} />,
        })),
        ...extra,
      ]}
    />
  );
}

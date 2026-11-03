import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Box,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  ListFilter,
  Search,
  WrapText,
  X,
} from "lucide-react";
import type {
  Containers,
  LogPod,
  LogsSession,
  LogsSnapshot,
  Since,
} from "@twigo/protocol";
import {
  ActionDropdown,
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  IconButton,
  notify,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SearchField,
  Segmented,
  StatusLabel,
  type Action,
} from "@twigo/ui";
import { useChanges, useWorkbench } from "@twigo/workbench";
import { TONE } from "../object/tone";
import type { LogsInput } from "../uri";
import { clock, currentMatch, followed, logsKind, podTag } from "./entries";
import { TAB_STREAMS, type LogsTabs } from "./state";

/** Where a session starts, as the range offers it (decision 22). */
const RANGES: readonly { id: string; label: string; since: Since }[] = [
  {
    id: "lines",
    label: "Last 1,000 lines per container",
    since: { type: "lines", lines: 1000 },
  },
  { id: "5m", label: "Last 5 min", since: { type: "seconds", seconds: 300 } },
  { id: "15m", label: "Last 15 min", since: { type: "seconds", seconds: 900 } },
  { id: "1h", label: "Last 1 h", since: { type: "seconds", seconds: 3600 } },
  { id: "6h", label: "Last 6 h", since: { type: "seconds", seconds: 21600 } },
  {
    id: "start",
    label: "Since each container started",
    since: { type: "start" },
  },
];

const TRIGGER =
  "inline-flex h-6.5 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs shadow-[inset_0_0_0_1px_var(--border)] outline-none hover:bg-row-hover focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-row-active";

/**
 * A logs tab's one toolbar (ARCHITECTURE 4.6): the pods and container, the
 * range, follow, wrap and timestamps, the level, a filter that keeps only
 * matching lines, and apart from it a search that steps through matches.
 */
export function LogsToolbar({
  uri,
  input,
  tabs,
  snapshot,
  session,
  narrow,
}: {
  uri: string;
  input: LogsInput;
  tabs: LogsTabs;
  snapshot: LogsSnapshot;
  session: LogsSession;
  narrow: boolean;
}) {
  const { keybindings } = useWorkbench();
  useChanges(keybindings.changes);
  const tab = tabs.get(uri);
  const { view, source } = tab;
  const filter = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const key = (command: string) => {
    const binding = keybindings.primary(command);
    return binding ? keybindings.label(binding.presses) : undefined;
  };

  useEffect(() => {
    if (tab.focus === undefined) return;
    (tab.focus === "filter" ? filter : search).current?.focus();
    tabs.focused(uri);
  }, [tab.focus, tabs, uri]);

  const counts = snapshot.histogram?.buckets.reduce(
    (sum, bucket) => ({
      warnings: sum.warnings + bucket.warnings + bucket.errors,
      errors: sum.errors + bucket.errors,
    }),
    { warnings: 0, errors: 0 },
  );
  const matches = snapshot.matches?.count ?? 0;
  const match = currentMatch(snapshot.matches, tab.current);
  // `current` counts back from the newest, so an older match is a larger one.
  const step = (older: boolean) => {
    const shown = snapshot.matches?.entries.length ?? 0;
    if (shown === 0) return;
    const current = (tab.current + (older ? 1 : shown - 1)) % shown;
    tabs.update(uri, { current, follow: false });
  };
  const range = view.range;

  return (
    <div className="flex h-9 min-w-0 flex-none items-center gap-1 overflow-hidden border-b border-border-subtle px-2">
      <PodPicker uri={uri} input={input} tabs={tabs} pods={snapshot.pods} />
      {range ? (
        <span className={TRIGGER}>
          <Clock aria-hidden className="size-3.5 text-muted-foreground" />
          <span className="tabular-nums">
            {clock(range.from).slice(0, 8)} – {clock(range.to).slice(0, 8)}
          </span>
          <button
            type="button"
            aria-label="Show the whole range"
            onClick={() => {
              tabs.setView(uri, { range: null });
            }}
            className="-mr-1 flex size-4 items-center justify-center rounded text-muted-foreground hover:bg-row-hover hover:text-foreground"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ) : (
        <ActionDropdown
          label="Where the lines start"
          align="start"
          actions={[
            RANGES.map(({ id, label, since }): Action => ({
              id,
              label,
              checked: sameSince(since, source.since),
              run: () => {
                tabs.setSource(uri, { since });
              },
            })),
          ]}
        >
          <button type="button" className={TRIGGER}>
            <Clock aria-hidden className="size-3.5 text-muted-foreground" />
            {RANGES.find(({ since }) => sameSince(since, source.since))
              ?.label ?? "Range"}
            <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
          </button>
        </ActionDropdown>
      )}
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <IconButton
        icon={ArrowDownToLine}
        label="Follow"
        keys={key("k8s.logs.toggleFollow")}
        pressed={tab.follow}
        onClick={() => {
          tabs.update(uri, { follow: !tab.follow });
        }}
      />
      <IconButton
        icon={WrapText}
        label="Wrap Lines"
        keys={key("k8s.logs.toggleWrap")}
        pressed={tab.wrap}
        onClick={() => {
          tabs.update(uri, { wrap: !tab.wrap });
        }}
      />
      <IconButton
        icon={Clock}
        label="Show Timestamps"
        keys={key("k8s.logs.toggleTimestamps")}
        pressed={tab.timestamps}
        onClick={() => {
          tabs.update(uri, { timestamps: !tab.timestamps });
        }}
      />
      <Segmented
        label="Level"
        className="ml-1.5 shrink-0"
        value={view.level}
        onChange={(level) => {
          tabs.setView(uri, { level });
        }}
        items={[
          { value: "all", label: "All" },
          {
            value: "warn",
            label: "Warn+",
            ...(!narrow && counts && { count: counts.warnings }),
          },
          {
            value: "error",
            label: "Error",
            tone: "error",
            ...(!narrow && counts && { count: counts.errors }),
          },
        ]}
      />
      <span className="flex-1" />
      <SearchField
        label="Only lines with"
        placeholder="Only lines with…"
        icon={ListFilter}
        value={view.filter ?? ""}
        onChange={(text) => {
          tabs.setView(uri, { filter: text === "" ? null : text });
        }}
        inputRef={filter}
        className={narrow ? "w-32 min-w-24" : "w-40 min-w-24"}
      />
      <SearchField
        label="Find in the lines"
        placeholder="Find"
        icon={Search}
        value={view.search ?? ""}
        onChange={(text) => {
          tabs.setView(uri, { search: text === "" ? null : text });
        }}
        onEnter={step}
        {...(key("k8s.logs.find") && { keys: key("k8s.logs.find") })}
        inputRef={search}
        trailing={
          <span className="flex shrink-0 items-center gap-0.5">
            <span className="pr-0.5 text-[11px] whitespace-nowrap tabular-nums">
              {match === undefined
                ? "No results"
                : `${match.number.toLocaleString("en")} of ${matches.toLocaleString("en")}`}
            </span>
            <IconButton
              icon={ChevronUp}
              label="Previous Match"
              className="size-4"
              onClick={() => {
                step(true);
              }}
            />
            <IconButton
              icon={ChevronDown}
              label="Next Match"
              className="size-4"
              onClick={() => {
                step(false);
              }}
            />
          </span>
        }
        className={narrow ? "w-56 min-w-44" : "w-64 min-w-44"}
      />
      <IconButton
        icon={Download}
        label="Download the Lines Shown…"
        onClick={() => {
          session.download(true).then(
            (path) => {
              if (path !== null) notify.success(`Saved to ${path}`);
            },
            (error: unknown) => {
              notify.error(String(error));
            },
          );
        }}
      />
    </div>
  );
}

function sameSince(a: Since, b: Since): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The pods a tab follows and their container, picked in one place: every
 * pod of the workload, new ones included, or some, each with its state.
 */
function PodPicker({
  uri,
  input,
  tabs,
  pods,
}: {
  uri: string;
  input: LogsInput;
  tabs: LogsTabs;
  pods: readonly LogPod[] | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { source } = tabs.get(uri);
  const kind = logsKind(input.gvr);
  const single = kind === "pod";
  const all = pods ?? [];
  const followedPods = all.filter((pod) => followed(pod).length > 0);
  const streaming = all.filter((pod) =>
    pod.containers.some(
      (each) =>
        each.stream.state !== "off" && each.stream.state !== "overLimit",
    ),
  );
  const names = [
    ...new Set(all.flatMap((pod) => pod.containers.map((c) => c.name))),
  ];
  const container = containerLabel(source.containers, followedPods);
  const label = single
    ? `pod …-${podTag(input.name)} · ${container}`
    : `${streaming.length === all.length ? String(all.length) : `${String(streaming.length)} of ${String(all.length)}`} ${all.length === 1 ? "pod" : "pods"} · ${container}`;
  const chosen = (pod: string) =>
    source.pods === null || source.pods.includes(pod);
  const toggle = (pod: string) => {
    const current = source.pods ?? all.map((each) => each.name);
    const next = current.includes(pod)
      ? current.filter((each) => each !== pod)
      : [...current, pod];
    tabs.setSource(uri, { pods: next });
  };
  const streams = followedPods.reduce(
    (sum, pod) => sum + followed(pod).length,
    0,
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={TRIGGER}>
          <Box aria-hidden className="size-3.5 text-muted-foreground" />
          {label}
          <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0">
        <Command loop>
          {!single && <CommandInput placeholder="Filter pods" />}
          <CommandList>
            {!single && (
              <CommandGroup>
                <CommandItem
                  value="__all"
                  onSelect={() => {
                    tabs.setSource(uri, { pods: null });
                  }}
                >
                  <Tick on={source.pods === null} />
                  <span className="flex-1">
                    All pods of {kind} {input.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    new pods join
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
            {!single && (
              <CommandGroup heading="Pods">
                {all.map((pod) => (
                  <CommandItem
                    key={pod.name}
                    value={pod.name}
                    onSelect={() => {
                      toggle(pod.name);
                    }}
                  >
                    <Tick on={chosen(pod.name)} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {pod.name.slice(0, pod.name.lastIndexOf("-") + 1)}
                      <span className="text-foreground">
                        {podTag(pod.name)}
                      </span>
                    </span>
                    <StreamLabel pod={pod} />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
          {names.length > 0 && (
            <div className="border-t border-border px-3.5 py-2">
              <div className="pb-1.5 text-[11px] font-medium text-muted-foreground">
                Container
              </div>
              <Segmented<string>
                label="Container"
                value={
                  source.containers.type === "named"
                    ? source.containers.name
                    : source.containers.type === "all"
                      ? "__all"
                      : "__default"
                }
                onChange={(value) => {
                  tabs.setSource(uri, {
                    containers:
                      value === "__default"
                        ? { type: "default" }
                        : value === "__all"
                          ? { type: "all" }
                          : { type: "named", name: value },
                  });
                }}
                items={[
                  { value: "__default", label: "Default" },
                  ...names.map((name) => ({ value: name, label: name })),
                  { value: "__all", label: "All containers" },
                ]}
              />
            </div>
          )}
          {!single && (
            <p className="border-t border-border px-3.5 py-2 text-[11.5px] text-muted-foreground">
              {streams >= TAB_STREAMS
                ? `A tab follows at most ${String(TAB_STREAMS)} containers at once; untick some pods to follow others.`
                : `A tab follows up to ${String(TAB_STREAMS)} containers at once.`}
            </p>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={
        on
          ? "flex size-3.5 items-center justify-center rounded bg-brand text-brand-foreground"
          : "size-3.5 rounded shadow-[inset_0_0_0_1px_var(--input)]"
      }
    >
      {on && <Check className="size-3" />}
    </span>
  );
}

/** A pod's state, or why its stream does not follow. */
function StreamLabel({ pod }: { pod: LogPod }) {
  const states = followed(pod).map((container) => container.stream);
  if (states.some((state) => state.state === "queued"))
    return <StatusLabel tone="warn">Queued</StatusLabel>;
  if (pod.tone !== "neutral")
    return <StatusLabel tone={TONE[pod.tone]}>{pod.status}</StatusLabel>;
  if (states.some((state) => state.state === "overLimit"))
    return <StatusLabel tone="idle">Not followed</StatusLabel>;
  if (states.length === 0) return <StatusLabel tone="idle">Off</StatusLabel>;
  return <StatusLabel tone="ok">Following</StatusLabel>;
}

/** The container the label names: the one picked, or the one the pods follow. */
function containerLabel(
  containers: Containers,
  pods: readonly LogPod[],
): string {
  if (containers.type === "named") return containers.name;
  if (containers.type === "all") return "all containers";
  const names = new Set(
    pods.flatMap((pod) => followed(pod).map((c) => c.name)),
  );
  const [only] = names;
  return names.size === 1 && only !== undefined ? only : "default";
}

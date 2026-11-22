import { useCallback, useState } from "react";
import { History as HistoryIcon } from "lucide-react";
import type { RevisionLine } from "@twigo/protocol";
import {
  cn,
  DataGrid,
  type ActionGroups,
  EmptyState,
  StatusDot,
  type GridColumn,
  type GridItem,
} from "@twigo/ui";
import {
  ErrorMessage,
  useChanges,
  useListRegistration,
} from "@twigo/workbench";
import { Age } from "../object/values";
import { problemWords, isQuiet, statusTone } from "./status";
import type { ReleaseStates } from "./states";

const COLUMNS: readonly GridColumn[] = [
  { id: "revision", title: "Revision", width: 80, align: "end", numeric: true },
  { id: "updated", title: "Updated", width: 72, align: "end", coverable: true },
  { id: "status", title: "Status", width: 152, coverable: false },
  { id: "chart", title: "Chart", width: 180 },
  { id: "appVersion", title: "App Version", width: 112 },
  { id: "description", title: "Description", width: 360, grow: true },
];

/**
 * The revisions of a release newest first, with the columns `helm history`
 * prints (ARCHITECTURE 4.3): the revision the cluster runs marked where it is
 * not the latest, the description as Helm wrote it with a value of the
 * revision's Secrets taken out, and a row that cannot be read saying why.
 * Marking two rows offers their comparisons; the menu of the selected row
 * opens one revision or compares it.
 */
export function HistoryList({
  uri,
  epoch,
  lines,
  latest,
  states,
  menu,
  onOpen,
}: {
  uri: string;
  /** What the marks belong to (`ReleaseSnapshot.epoch`). */
  epoch: number;
  lines: readonly RevisionLine[];
  latest: number | undefined;
  states: ReleaseStates;
  /** The menu of the selected revision, and of the marked ones. */
  menu: (revision: number, marked: readonly number[]) => ActionGroups;
  onOpen: (revision: number) => void;
}) {
  useChanges(states.changes);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const register = useListRegistration({ "resource.group": "helm.sh" });
  const registerGrid = useCallback(
    (element: HTMLElement, controller: Parameters<typeof register>[1]) => {
      return register(element, controller);
    },
    [register],
  );
  const marked = states.marks(uri, epoch);
  if (lines.length === 0) {
    return (
      <EmptyState icon={HistoryIcon} title="No revisions">
        Helm keeps none of this release's revisions.
      </EmptyState>
    );
  }
  const current = selected ?? lines[0]?.revision;
  const byId = new Map(lines.map((line) => [String(line.revision), line]));
  const item = (index: number): GridItem<RevisionLine, never> | undefined => {
    const line = lines[index];
    if (!line) return undefined;
    return {
      type: "row",
      id: String(line.revision),
      data: line,
      ...(line.problem && { tone: "error" as const }),
    };
  };
  return (
    <DataGrid<RevisionLine, never>
      label="Revisions"
      columns={COLUMNS}
      length={lines.length}
      query={`${uri}\n${String(lines.length)}`}
      item={item}
      indexOf={(id) => lines.findIndex((line) => String(line.revision) === id)}
      onRange={() => undefined}
      selected={current === undefined ? undefined : String(current)}
      onSelect={(id) => {
        setSelected(Number(id));
      }}
      onActivate={() => undefined}
      onOpen={(id) => {
        onOpen(Number(id));
      }}
      marked={new Set([...marked].map(String))}
      onMark={(ids, on) => {
        states.mark(uri, epoch, ids.map(Number), on);
      }}
      menu={
        current === undefined || !byId.has(String(current))
          ? []
          : menu(current, [...marked])
      }
      loading={false}
      cell={(line, column) => {
        switch (column.id) {
          case "revision":
            return String(line.revision);
          case "updated":
            return line.updated ? (
              <Age at={line.updated} />
            ) : (
              <span className="text-quiet" />
            );
          case "status":
            return <StatusWord line={line} latest={latest} />;
          case "chart":
            return line.chart ?? <span className="text-quiet" />;
          case "appVersion":
            return line.appVersion ?? <span className="text-quiet" />;
          default:
            return <Description line={line} />;
        }
      }}
      register={registerGrid}
    />
  );
}

function StatusWord({
  line,
  latest,
}: {
  line: RevisionLine;
  latest: number | undefined;
}) {
  if (line.problem) {
    const { word, why } = problemWords(line.problem.code);
    return (
      <span
        title={why}
        className="inline-flex items-center gap-1.5 align-top font-semibold text-error"
      >
        <StatusDot tone="error" />
        {word}
      </span>
    );
  }
  const tone = statusTone(line.status);
  if (tone) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 align-top font-semibold",
          tone === "error" ? "text-error" : "text-warn-foreground",
        )}
      >
        <StatusDot tone={tone} pulse={line.status.startsWith("pending-")} />
        {line.status}
      </span>
    );
  }
  if (line.status === "deployed" && line.revision !== latest) {
    return (
      <span className="inline-flex items-center gap-1.5 align-top">
        <StatusDot tone="ok" />
        {line.status}
      </span>
    );
  }
  return (
    <span className={isQuiet(line.status) ? "text-quiet" : "text-support"}>
      {line.status}
    </span>
  );
}

function Description({ line }: { line: RevisionLine }) {
  if (line.problem) {
    return (
      <span className="truncate text-support">
        <ErrorMessage error={line.problem} />
      </span>
    );
  }
  const text = line.description?.text ?? "";
  const rolled =
    line.rollbackOf !== null && !text.includes(String(line.rollbackOf))
      ? `${text} · rollback to ${String(line.rollbackOf)}`
      : text;
  return <span className="truncate">{rolled}</span>;
}

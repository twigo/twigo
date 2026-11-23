import { useCallback, useState } from "react";
import { History as HistoryIcon } from "lucide-react";
import type { RevisionLine } from "@twigo/protocol";
import {
  ActionBar,
  DataGrid,
  type ActionGroups,
  EmptyState,
  StatusLabel,
  type GridColumn,
  type GridItem,
} from "@twigo/ui";
import {
  ErrorMessage,
  useChanges,
  useListRegistration,
} from "@twigo/workbench";
import { Age } from "../object/values";
import { CutWord } from "./CutWord";
import { ProblemWord } from "./ProblemWord";
import { RequestFailed } from "./RequestFailed";
import { IN_FLIGHT_RELEASE, isQuiet, statusTone, UNREADABLE } from "./status";
import type { ReleaseStates } from "./states";

const COLUMNS: readonly GridColumn[] = [
  { id: "revision", title: "Revision", width: 80, align: "end", numeric: true },
  { id: "updated", title: "Updated", width: 72, align: "end", coverable: true },
  { id: "status", title: "Status", width: 160, coverable: false },
  { id: "chart", title: "Chart", width: 180 },
  { id: "appVersion", title: "App Version", width: 112 },
  { id: "description", title: "Description", width: 360, grow: true },
];

/**
 * The revisions of a release newest first, with the columns `helm history`
 * prints (ARCHITECTURE 4.3): the revision the cluster runs marked where it is
 * not the latest, the description as Helm wrote it with a value of the
 * revision's Secrets taken out, a row that cannot be read saying why, and one
 * whose request failed marked, as the list's row is.
 * Marking two rows offers their comparisons; the menu of the selected row
 * opens one revision or compares it.
 */
export function HistoryList({
  uri,
  life,
  lines,
  latest,
  states,
  menu,
  bar,
  onOpen,
}: {
  uri: string;
  life: number;
  lines: readonly RevisionLine[];
  latest: number | undefined;
  states: ReleaseStates;
  /** The menu of the selected revision, and of the marked ones. */
  menu: (revision: number, marked: readonly number[]) => ActionGroups;
  /** The actions of the bar over the marked revisions. */
  bar: (marked: readonly number[]) => ActionGroups;
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
  if (lines.length === 0) {
    return (
      <EmptyState icon={HistoryIcon} title="No revisions">
        Helm keeps none of this release's revisions.
      </EmptyState>
    );
  }
  const current = selected ?? lines[0]?.revision;
  const byId = new Map(lines.map((line) => [String(line.revision), line]));
  const marked = [...states.marks(uri, life)].filter((revision) =>
    byId.has(String(revision)),
  );
  const item = (index: number): GridItem<RevisionLine, never> | undefined => {
    const line = lines[index];
    if (!line) return undefined;
    const tone = statusTone(line.status);
    return {
      type: "row",
      id: String(line.revision),
      data: line,
      ...(tone && { tone }),
    };
  };
  return (
    <>
      <DataGrid<RevisionLine, never>
        label="Revisions"
        columns={COLUMNS}
        length={lines.length}
        query={`${uri}\n${String(lines.length)}`}
        item={item}
        indexOf={(id) =>
          lines.findIndex((line) => String(line.revision) === id)
        }
        onRange={() => undefined}
        selected={current === undefined ? undefined : String(current)}
        onSelect={(id) => {
          setSelected(Number(id));
        }}
        onActivate={() => undefined}
        onOpen={(id) => {
          onOpen(Number(id));
        }}
        marked={new Set(marked.map(String))}
        onMark={(ids, on) => {
          states.mark(uri, life, ids.map(Number), on);
        }}
        menu={
          current === undefined || !byId.has(String(current))
            ? []
            : menu(current, marked)
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
      {marked.length > 0 && (
        <div className="absolute bottom-3 left-1/2 z-[5] -translate-x-1/2">
          <ActionBar actions={bar(marked)}>
            <span className="px-2 tabular-nums">
              <span className="font-semibold">{marked.length}</span> marked
            </span>
          </ActionBar>
        </div>
      )}
    </>
  );
}

function StatusWord({
  line,
  latest,
}: {
  line: RevisionLine;
  latest: number | undefined;
}) {
  if (line.problem && line.status === UNREADABLE)
    return <ProblemWord code={line.problem.code} />;
  const word = <Status line={line} latest={latest} />;
  return line.problem ? (
    <RequestFailed
      code={line.problem.code}
      what={`revision ${String(line.revision)}`}
    >
      {word}
    </RequestFailed>
  ) : (
    word
  );
}

function Status({
  line,
  latest,
}: {
  line: RevisionLine;
  latest: number | undefined;
}) {
  const tone = statusTone(line.status);
  if (tone) {
    return (
      <StatusLabel
        tone={tone}
        pulse={IN_FLIGHT_RELEASE.test(line.status)}
        className="max-w-full align-top font-semibold"
      >
        <CutWord text={line.status} />
      </StatusLabel>
    );
  }
  if (line.status === "deployed" && line.revision !== latest) {
    return (
      <StatusLabel tone="ok" className="max-w-full align-top">
        {line.status}
      </StatusLabel>
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

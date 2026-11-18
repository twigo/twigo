import { Fragment, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ContextColor, Gvr, ObjectRef, Span } from "@twigo/protocol";
import { cn, CutInTheMiddle, LinkButton, Pill } from "@twigo/ui";
import { humanDuration } from "@twigo/utils";
import { ageRole } from "../age";
import { KindIcon } from "../KindIcon";
import { ObjectName } from "../ObjectName";
import { useNow } from "../useNow";
import { SaidLine } from "./values";
import type { Verdict } from "./verdict";

const NODES: Gvr = { group: "", version: "v1", resource: "nodes" };

const FLOOR = 12;

/** A context's colour as text, by the tokens the title bar's tint uses. */
const INK: Readonly<Record<ContextColor, string>> = {
  red: "text-context-red-ink",
  orange: "text-context-orange-ink",
  yellow: "text-context-yellow-ink",
  green: "text-context-green-ink",
  blue: "text-context-blue-ink",
  purple: "text-context-purple-ink",
};

export interface HeaderOwner {
  readonly target: ObjectRef;
  /** The owner's resource, once discovery has it, for its icon. */
  readonly gvr: Gvr | undefined;
}

/**
 * The three lines the inspector and the full page share (ARCHITECTURE 4.3):
 * who it is, where it is, and how it is, then what can be done with it. Each
 * line holds its height, so that arrowing through rows of one kind moves
 * nothing under it: the verdict's line is drawn for a kind that always has
 * one, even before its sentence comes. The full page leads the second line
 * with the space's name in its context's colour, as the tab's path reads.
 */
export function ObjectHeader({
  gvr,
  kind,
  name,
  generated,
  controls,
  space,
  namespace,
  owner,
  node,
  created,
  verdict,
  sentence,
  verdictLine,
  onOpen,
  actions,
}: {
  gvr: Gvr;
  kind: string;
  name: string;
  generated: number | null;
  controls: ReactNode;
  /** The space's name and its context's colour, which only the full page leads its second line with. */
  space?: { readonly name: string; readonly color: ContextColor | undefined };
  namespace: string | undefined;
  owner: HeaderOwner | undefined;
  node: string | undefined;
  /** RFC 3339. */
  created: string | undefined;
  verdict: Verdict | undefined;
  sentence: readonly Span[];
  /** Whether the third line is drawn: for a kind that has a verdict or vitals, always. */
  verdictLine: boolean;
  onOpen: (target: ObjectRef) => void;
  actions: ReactNode;
}) {
  const place = [
    space && (
      <span
        key="space"
        title={space.name}
        className={cn(
          "min-w-0 truncate font-semibold",
          space.color && INK[space.color],
        )}
      >
        {space.name}
      </span>
    ),
    namespace !== undefined && (
      <span key="namespace" className="ident min-w-0 shrink-[0.1] truncate">
        {namespace}
      </span>
    ),
    owner && (
      <LinkButton
        key="owner"
        onClick={() => {
          onOpen(owner.target);
        }}
        title={`${owner.target.kind} ${owner.target.name}`}
        label={`${owner.target.kind} ${owner.target.name}`}
        className="flex min-w-0 shrink-[2] items-center gap-1"
      >
        {owner.gvr && <KindIcon gvr={owner.gvr} className="size-3 shrink-0" />}
        <span className="ident shrink-0">{owner.target.kind}</span>
        <span className="ident block min-w-0">
          <CutInTheMiddle
            text={owner.target.name}
            floor={FLOOR}
            separator="-"
          />
        </span>
      </LinkButton>
    ),
  ].filter(Boolean);
  const rest = [
    node !== undefined && (
      <LinkButton
        key="node"
        onClick={() => {
          onOpen({
            group: "",
            version: "v1",
            kind: "Node",
            namespace: null,
            name: node,
          });
        }}
        title={`Node ${node}`}
        label={`Node ${node}`}
        className="flex min-w-0 shrink-[4] items-center gap-1"
      >
        <KindIcon gvr={NODES} className="size-3 shrink-0" />
        <span className="ident block min-w-0">
          <CutInTheMiddle text={node} floor={FLOOR} separator="-" />
        </span>
      </LinkButton>
    ),
    created !== undefined && <Age key="age" at={created} />,
  ].filter(Boolean);
  return (
    <header className="flex shrink-0 flex-col border-b border-border-subtle pt-2 pr-2 pb-2 pl-3.5">
      <div className="flex h-7 items-center gap-1.5">
        <KindIcon gvr={gvr} className="size-4 shrink-0 text-support" />
        <h2 className="flex min-w-0 flex-1 items-baseline text-title font-semibold text-strong">
          <span className="min-w-0 truncate text-xs text-support">{kind}</span>{" "}
          <ObjectName
            name={name}
            generated={generated}
            className="max-w-full shrink-0 pl-1.5 text-strong"
          />
        </h2>
        {controls}
      </div>
      <div className="flex h-5 min-w-0 items-center gap-1 text-xs text-support">
        <Separated
          parts={place}
          by={
            space ? (
              <ChevronRight
                aria-hidden
                className="size-3 shrink-0 text-quiet"
              />
            ) : (
              <Dot />
            )
          }
        />
        {place.length > 0 && rest.length > 0 && <Dot />}
        <Separated parts={rest} by={<Dot />} />
      </div>
      {verdictLine && (
        <div
          role="group"
          aria-label="Verdict"
          className="flex h-6 min-w-0 items-center gap-2"
        >
          {verdict && <Pill tone={verdict.tone ?? "ok"}>{verdict.word}</Pill>}
          <SaidLine spans={sentence} className="text-body text-content" />
        </div>
      )}
      <div className="mt-1.5 -ml-1.5">{actions}</div>
    </header>
  );
}

function Dot() {
  return (
    <span aria-hidden className="shrink-0 text-quiet">
      ·
    </span>
  );
}

function Separated({
  parts,
  by,
}: {
  parts: readonly ReactNode[];
  by: ReactNode;
}) {
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && by}
      {part}
    </Fragment>
  ));
}

/** An age that ticks, in content for its first ten minutes. */
function Age({ at }: { at: string }) {
  const age = useNow() - Date.parse(at);
  return (
    <span className={cn("shrink-0 tabular-nums", ageRole(age))}>
      {humanDuration(age)}
    </span>
  );
}

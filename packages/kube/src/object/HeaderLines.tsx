import { Fragment, memo, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { ContextColor, Gvr, ObjectRef } from "@twigo/protocol";
import { cn, CutInTheMiddle, LinkButton } from "@twigo/ui";
import { humanDuration, widestDuration } from "@twigo/utils";
import { ageRole } from "../age";
import { KindIcon } from "../KindIcon";
import { ObjectName } from "../ObjectName";
import { useNowAs } from "../useNow";
import {
  FLOOR,
  PLACE_STAGES,
  TITLE_STAGES,
  type Form,
  type PlaceStage,
  type TitleStage,
} from "./headerStage";
import { useLineStage } from "./useLineStage";

const NODES: Gvr = { group: "", version: "v1", resource: "nodes" };

/** A context's colour as text, by the tokens the title bar's tint uses. */
const INK: Readonly<Record<ContextColor, string>> = {
  red: "text-context-red-ink",
  orange: "text-context-orange-ink",
  yellow: "text-context-yellow-ink",
  green: "text-context-green-ink",
  blue: "text-context-blue-ink",
  purple: "text-context-purple-ink",
};

const LINK = "flex items-center gap-1";

/** A hidden box of a line's stages drawn at their narrowest, one child each, which `useLineStage` reads. */
const COPIES =
  "pointer-events-none invisible absolute top-0 left-0 h-0 overflow-hidden";

export interface HeaderOwner {
  readonly target: ObjectRef;
  /** The owner's resource, once discovery has it, for its icon. */
  readonly gvr: Gvr | undefined;
}

/**
 * A text whole, or cut in the middle: by CSS down to its floor, or held at it.
 * A cut that nothing else names is `spoken`: its cells are hidden from
 * assistive technology and the whole text is said instead, which a copy of the
 * line does not carry.
 */
function Text({
  text,
  form,
  className,
  title,
  spoken = false,
}: {
  text: string;
  form: Form;
  className?: string;
  title?: string | undefined;
  spoken?: boolean;
}) {
  if (form === "whole")
    return (
      <span title={title} className={cn("ident shrink-0", className)}>
        {text}
      </span>
    );
  return (
    <span
      title={title}
      className={cn(
        "ident block",
        form === "floor" && "w-min shrink-0",
        className,
      )}
    >
      <CutInTheMiddle
        text={text}
        floor={FLOOR}
        separator="-"
        {...(spoken && { "aria-hidden": true })}
      />
      {spoken && <span className="sr-only select-none">{text}</span>}
    </span>
  );
}

/** What a stage draws of a name, which a copy draws at its narrowest. */
function Title({
  stage,
  least,
  kind,
  name,
  generated,
  title,
}: {
  stage: TitleStage;
  least: boolean;
  kind: string;
  name: string;
  generated: number | null;
  title?: string | undefined;
}) {
  return (
    <>
      {stage.kind && (
        <span className="shrink-0 text-xs text-support">{kind}</span>
      )}
      {stage.name === "middle" ? (
        <Text
          text={name}
          form={least ? "floor" : "cut"}
          className="text-strong"
          title={title}
        />
      ) : (
        <ObjectName
          name={name}
          generated={generated}
          least={least && stage.name === "hash"}
          title={title}
          className={
            stage.name === "whole" ? "shrink-0 text-strong" : "text-strong"
          }
        />
      )}
    </>
  );
}

/**
 * The first line: the kind's icon, the kind word and the name, and the
 * controls. The name takes what the controls leave, in the fullest of its
 * stages that fits: the kind word and the whole name; the name's generated
 * part cut; the kind word gone, its icon saying it; the name cut in the middle.
 */
export function TitleLine({
  object,
  gvr,
  kind,
  name,
  generated,
  controls,
}: {
  object: string;
  gvr: Gvr;
  kind: string;
  name: string;
  generated: number | null;
  controls: ReactNode;
}) {
  const [room, setRoom] = useState<HTMLElement | null>(null);
  const [copies, setCopies] = useState<HTMLElement | null>(null);
  const { at, stage, settled } = useLineStage(
    TITLE_STAGES,
    room,
    copies,
    object,
  );
  const said = `${kind} ${name}`;
  return (
    <div className="relative flex h-7 items-center gap-1.5">
      <span
        aria-hidden
        className="flex shrink-0"
        {...(!stage.kind && { title: kind })}
      >
        <KindIcon gvr={gvr} className="size-4 text-support" />
      </span>
      <h2
        ref={setRoom}
        aria-label={said}
        data-stage={at}
        className="flex min-w-0 flex-1 items-baseline gap-1.5 text-title font-semibold text-strong"
      >
        <Title
          stage={stage}
          least={false}
          kind={kind}
          name={name}
          generated={generated}
          title={at === 0 ? undefined : stage.kind ? name : said}
        />
      </h2>
      {controls}
      <TitleCopies
        copies={setCopies}
        settled={settled}
        kind={kind}
        name={name}
        generated={generated}
      />
    </div>
  );
}

/**
 * The stages of the first line at their narrowest, which each cut reads its
 * font to draw: drawn again only for another name once every copy is
 * measured, and with each render of the line before, as a cut whose font
 * could not be read waits for one.
 */
const TitleCopies = memo(
  function TitleCopies({
    copies,
    kind,
    name,
    generated,
  }: {
    copies: (box: HTMLElement | null) => void;
    settled: boolean;
    kind: string;
    name: string;
    generated: number | null;
  }) {
    return (
      <div aria-hidden inert ref={copies} className={COPIES}>
        {TITLE_STAGES.map((each, index) => (
          <div
            key={index}
            data-stage={index}
            className="flex w-max items-baseline gap-1.5 text-title font-semibold"
          >
            <Title
              stage={each}
              least
              kind={kind}
              name={name}
              generated={generated}
            />
          </div>
        ))}
      </div>
    );
  },
  (before, after) =>
    before.settled &&
    after.settled &&
    before.copies === after.copies &&
    before.kind === after.kind &&
    before.name === after.name &&
    before.generated === after.generated,
);

interface Place {
  /** The space's name and its context's colour, which only the full page leads its line with. */
  readonly space:
    | { readonly name: string; readonly color: ContextColor | undefined }
    | undefined;
  readonly namespace: string | undefined;
  readonly owner: HeaderOwner | undefined;
  readonly node: string | undefined;
  /** RFC 3339. */
  readonly created: string | undefined;
}

/** What a stage draws of the second line, which a copy draws at its narrowest. */
function Parts({
  place: { space, namespace, owner, node, created },
  stage,
  least,
  onOpen,
}: {
  place: Place;
  stage: PlaceStage;
  least: boolean;
  /** A copy has none: it draws its links as text. */
  onOpen?: (target: ObjectRef) => void;
}) {
  const formOf = (form: Form): Form =>
    least && form === "cut" ? "floor" : form;
  const leading = [
    space && (
      <span
        key="space"
        title={space.name}
        className={cn(
          "shrink-0 font-semibold",
          space.color && INK[space.color],
        )}
      >
        {space.name}
      </span>
    ),
    namespace !== undefined && (
      <Text
        key="namespace"
        text={namespace}
        form={formOf(stage.namespace)}
        spoken={!least}
      />
    ),
    owner && (
      <Linked
        key="owner"
        least={least}
        form={formOf(stage.owner)}
        said={`${owner.target.kind} ${owner.target.name}`}
        onOpen={() => {
          onOpen?.(owner.target);
        }}
      >
        {owner.gvr && <KindIcon gvr={owner.gvr} className="size-3 shrink-0" />}
        {stage.ownerKind && (
          <span className="ident shrink-0">{owner.target.kind}</span>
        )}
        <Text text={owner.target.name} form={formOf(stage.owner)} />
      </Linked>
    ),
  ].filter(Boolean);
  const trailing = [
    node !== undefined && stage.node !== "left" && (
      <Linked
        key="node"
        least={least}
        form={formOf(stage.node)}
        said={`Node ${node}`}
        onOpen={() => {
          onOpen?.({
            group: "",
            version: "v1",
            kind: "Node",
            namespace: null,
            name: node,
          });
        }}
      >
        <KindIcon gvr={NODES} className="size-3 shrink-0" />
        <Text text={node} form={formOf(stage.node)} />
      </Linked>
    ),
    created !== undefined &&
      (least ? (
        <AgeRoom key="age" at={created} />
      ) : (
        <Age key="age" at={created} />
      )),
  ].filter(Boolean);
  return (
    <>
      <Separated
        parts={leading}
        by={
          space ? (
            <ChevronRight aria-hidden className="size-3 shrink-0 text-quiet" />
          ) : (
            <Dot />
          )
        }
      />
      {leading.length > 0 && trailing.length > 0 && <Dot />}
      <Separated parts={trailing} by={<Dot />} />
    </>
  );
}

/** A link that opens an object, which says what it is whole in its name and its tooltip, and which a copy draws as plain text. */
function Linked({
  least,
  form,
  said,
  onOpen,
  children,
}: {
  least: boolean;
  form: Form;
  said: string;
  onOpen: () => void;
  children: ReactNode;
}) {
  if (least) return <span className={LINK}>{children}</span>;
  return (
    <LinkButton
      onClick={onOpen}
      title={said}
      label={said}
      className={cn(LINK, form === "cut" ? "shrink" : "shrink-0")}
    >
      {children}
    </LinkButton>
  );
}

/**
 * The second line: where the object is. In the fullest of its stages that
 * fits, every part whole; the node cut in the middle; the owner's name cut
 * too; the owner's kind word gone; the node gone; the namespace cut. The age
 * never cuts and never leaves, and a dot goes with the part it separates.
 */
export function PlaceLine({
  object,
  place,
  onOpen,
}: {
  object: string;
  place: Place;
  onOpen: (target: ObjectRef) => void;
}) {
  const [room, setRoom] = useState<HTMLElement | null>(null);
  const [copies, setCopies] = useState<HTMLElement | null>(null);
  const { at, stage, settled } = useLineStage(
    PLACE_STAGES,
    room,
    copies,
    object,
  );
  const { namespace, owner, node } = place;
  const lost = stage.node === "left" || stage.namespace !== "whole";
  return (
    <div
      ref={setRoom}
      data-stage={at}
      title={
        lost
          ? [
              namespace,
              owner && `${owner.target.kind} ${owner.target.name}`,
              node && `Node ${node}`,
            ]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
      className="relative flex h-5 min-w-0 items-center gap-1 text-xs text-support"
    >
      <Parts place={place} stage={stage} least={false} onOpen={onOpen} />
      <PlaceCopies copies={setCopies} settled={settled} place={place} />
    </div>
  );
}

const samePlace = (a: Place, b: Place) =>
  a.space?.name === b.space?.name &&
  a.space?.color === b.space?.color &&
  a.namespace === b.namespace &&
  a.owner?.target.kind === b.owner?.target.kind &&
  a.owner?.target.name === b.owner?.target.name &&
  (a.owner?.gvr === undefined) === (b.owner?.gvr === undefined) &&
  a.node === b.node &&
  a.created === b.created;

/** The stages of the second line at their narrowest, drawn again as `TitleCopies` is, for another place. */
const PlaceCopies = memo(
  function PlaceCopies({
    copies,
    place,
  }: {
    copies: (box: HTMLElement | null) => void;
    settled: boolean;
    place: Place;
  }) {
    return (
      <div aria-hidden inert ref={copies} className={COPIES}>
        {PLACE_STAGES.map((each, index) => (
          <div
            key={index}
            data-stage={index}
            className="flex w-max items-center gap-1"
          >
            <Parts place={place} stage={each} least />
          </div>
        ))}
      </div>
    );
  },
  (before, after) =>
    before.settled &&
    after.settled &&
    before.copies === after.copies &&
    samePlace(before.place, after.place),
);

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

/** An age that ticks, in content for its first ten minutes, and draws again only when its text, its role or its room changes. It keeps the room of the widest age of its range, so a tick moves no width, and the line's stage no more than a change of range does. */
function Age({ at }: { at: string }) {
  const since = (now: number) => now - Date.parse(at);
  const text = useNowAs((now) => humanDuration(since(now)));
  const widest = useNowAs((now) => widestDuration(since(now)));
  const role = useNowAs((now) => ageRole(since(now)));
  return (
    <span
      data-widest={widest}
      className={cn(
        "inline-block shrink-0 tabular-nums after:invisible after:block after:h-0 after:overflow-hidden after:content-[attr(data-widest)]",
        role,
      )}
    >
      {text}
    </span>
  );
}

/** What a copy of the line takes of an age: the room of the widest age of its range, drawn again only when the range changes. */
function AgeRoom({ at }: { at: string }) {
  const widest = useNowAs((now) => widestDuration(now - Date.parse(at)));
  return <span className="inline-block shrink-0 tabular-nums">{widest}</span>;
}

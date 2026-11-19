import type { ReactNode } from "react";
import type { ContextColor, Gvr, ObjectRef, Span } from "@twigo/protocol";
import { Pill } from "@twigo/ui";
import { PlaceLine, TitleLine, type HeaderOwner } from "./HeaderLines";
import { SaidLine } from "./values";
import type { Verdict } from "./verdict";

/**
 * The three lines the inspector and the full page share (ARCHITECTURE 4.3):
 * who it is, where it is, and how it is, then what can be done with it. Each
 * line holds its height, so that arrowing through rows of one kind moves
 * nothing under it: the verdict's line is drawn for a kind that always has
 * one, even before its sentence comes. The full page leads the second line
 * with the space's name in its context's colour, as the tab's path reads.
 */
export function ObjectHeader({
  object,
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
  /** What the header draws, such as the object's URI: its lines take the fullest stage that fits another object's, where the same object's changes are held by the margin. An object deleted and made again under the URI is another, which `created` tells. */
  object: string;
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
  const drawn = `${object}\n${created ?? ""}`;
  return (
    <header className="flex shrink-0 flex-col border-b border-border-subtle pt-2 pr-2 pb-2 pl-3.5">
      <TitleLine
        object={drawn}
        gvr={gvr}
        kind={kind}
        name={name}
        generated={generated}
        controls={controls}
      />
      <PlaceLine
        object={drawn}
        place={{ space, namespace, owner, node, created }}
        onOpen={onOpen}
      />
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

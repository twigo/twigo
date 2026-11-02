import type { Gvr } from "@twigo/protocol";
import { Hexagon } from "lucide-react";
import { iconKey, KIND_ICONS } from "./kinds";
import { parseListUri, parseObjectUri } from "./uri";

export function KindIcon({ gvr, className }: { gvr: Gvr; className?: string }) {
  const Icon = KIND_ICONS[iconKey(gvr)] ?? Hexagon;
  return <Icon className={className} />;
}

const UNKNOWN: Gvr = { group: "", version: "", resource: "" };

/** A list editor's tab icon, by the kind in its URI. */
export function ListIcon({
  uri,
  className,
}: {
  uri: string;
  className?: string;
}) {
  return (
    <KindIcon gvr={parseListUri(uri)?.gvr ?? UNKNOWN} className={className} />
  );
}

/** An object editor's tab icon, by the kind in its URI. */
export function ObjectIcon({
  uri,
  className,
}: {
  uri: string;
  className?: string;
}) {
  return (
    <KindIcon gvr={parseObjectUri(uri)?.gvr ?? UNKNOWN} className={className} />
  );
}

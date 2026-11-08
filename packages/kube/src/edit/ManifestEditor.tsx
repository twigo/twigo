import { useMemo } from "react";
import { EmptyState } from "@twigo/ui";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { useResources, type Discovery } from "../discovery";
import { parseUntitledUri } from "../uri";
import { kindOf, parseManifest } from "./object";
import type { EditServices } from "./services";
import { YamlSurface } from "./YamlSurface";

/**
 * An `untitled://<space>/manifest-n` editor (ARCHITECTURE 4.3): YAML that is
 * not an object's yet, written in the space its URI names. Its first apply
 * asks which context it goes to.
 */
export function ManifestEditor({
  uri,
  edits,
  discovery,
}: EditorProps & { edits: EditServices; discovery: Discovery }) {
  const { spaces } = useWorkbench();
  const { copies, previews } = edits;
  useChanges(copies.changes);
  useChanges(spaces.changes);
  const copy = copies.get(uri);
  const text = copy?.text ?? "";
  const home = parseUntitledUri(uri)?.space;
  const target = copy?.target;
  const resources = useResources(discovery, target ?? home ?? "");
  // The schema is asked of a kind the cluster serves, not of each prefix of one being typed.
  const kind = useMemo(() => {
    const parsed = parseManifest(text);
    const named = parsed.ok ? kindOf(parsed.object) : undefined;
    return resources.state === "ready" &&
      resources.value.some(
        ({ gvr, kind }) =>
          gvr.group === named?.group &&
          gvr.version === named.version &&
          kind === named.kind,
      )
      ? named
      : undefined;
  }, [text, resources]);
  const targetName = spaces.list.find(({ id }) => id === target)?.name;
  // Discovery follows the space shown, so a target not visited has no kinds to ask a schema of.
  const unknownKinds = target !== undefined && resources.state !== "ready";
  if (home === undefined) {
    return <EmptyState title="Not a manifest">{uri}</EmptyState>;
  }

  return (
    <YamlSurface
      edits={edits}
      uri={uri}
      space={target ?? home}
      text={text}
      onChange={(next) => {
        previews.edited(uri);
        copies.write(uri, home, next);
      }}
      statusLocked={false}
      schemaKind={kind}
      note={
        targetName === undefined
          ? "New manifest: write or paste YAML, then Apply… asks which context it goes to"
          : `New manifest for ${targetName}${unknownKinds ? " · No schema for completion" : ""}`
      }
    />
  );
}

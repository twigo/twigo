import { useEffect, useMemo } from "react";
import { useChanges } from "@twigo/workbench";
import { kindOf, resourceVersionOf, yamlOfJson } from "./object";
import type { EditServices } from "./services";
import { YamlSurface } from "./YamlSurface";

/**
 * The YAML tab of an object's editor (ARCHITECTURE 4.3): the live object's
 * text until the person changes it, then a working copy that the live
 * object does not overwrite, and once it is applied that text again until
 * the live object shows the change.
 */
export function YamlTab({
  edits,
  uri,
  space,
  json,
  statusLocked,
}: {
  edits: EditServices;
  uri: string;
  space: string;
  json: string;
  statusLocked: boolean;
}) {
  const { copies, previews } = edits;
  useChanges(copies.changes);
  const live = useMemo(() => yamlOfJson(json), [json]);
  const kind = useMemo(() => kindOf(JSON.parse(json)), [json]);
  const text = copies.get(uri)?.text ?? copies.held(uri) ?? live;
  useEffect(() => {
    copies.see(uri, json, statusLocked);
  }, [copies, uri, json, statusLocked]);

  return (
    <YamlSurface
      edits={edits}
      uri={uri}
      space={space}
      text={text}
      onChange={(next) => {
        previews.edited(uri);
        copies.edit(uri, next, {
          space,
          base: json,
          lock: resourceVersionOf(json) ?? "",
        });
      }}
      statusLocked={statusLocked}
      schemaKind={kind}
      note={
        copies.get(uri)
          ? "Edited, not applied"
          : copies.held(uri) === undefined
            ? "In sync with the cluster"
            : "Applied, waiting for the cluster's copy"
      }
    />
  );
}

import { useMemo } from "react";
import { useChanges, useWorkbench, type EditorProps } from "@twigo/workbench";
import { PreviewPage } from "./answers";
import { kindOf, parseManifest } from "./object";
import type { EditServices } from "./services";
import { YamlSurface } from "./YamlSurface";

/**
 * An `untitled://manifest-n` editor (ARCHITECTURE 4.3): YAML that is not an
 * object's yet. Its first apply asks which context it goes to.
 */
export function ManifestEditor({
  uri,
  edits,
}: EditorProps & { edits: EditServices }) {
  const { spaces } = useWorkbench();
  const { copies, previews } = edits;
  useChanges(copies.changes);
  useChanges(previews.changes);
  useChanges(spaces.changes);
  const copy = copies.get(uri);
  const text = copy?.text ?? "";
  const home = copy?.space ?? spaces.active?.id;
  const kind = useMemo(() => {
    const parsed = parseManifest(text);
    return parsed.ok ? kindOf(parsed.object) : undefined;
  }, [text]);
  const target = copy?.target;
  const targetName = spaces.list.find(({ id }) => id === target)?.name;

  if (previews.inPlace(uri)) {
    return (
      <PreviewPage
        edits={edits}
        uri={uri}
        preview={previews.get(uri)}
        current={text}
      />
    );
  }
  return (
    <YamlSurface
      edits={edits}
      uri={uri}
      space={target ?? home}
      text={text}
      onChange={(next) => {
        if (home === undefined) return;
        previews.edited(uri);
        copies.write(uri, home, next);
      }}
      statusLocked={false}
      schemaKind={kind}
      note={
        targetName === undefined
          ? "New manifest: write or paste YAML, then Apply… asks which context it goes to"
          : `New manifest for ${targetName}`
      }
    />
  );
}

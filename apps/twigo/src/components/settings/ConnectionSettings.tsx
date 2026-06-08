import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Check } from "lucide-react";
import { Button, Input, Label } from "@twigo/ui";
import { useSettings } from "@/store/settings";
import { useConnections } from "@/store/connections";
import { defaultContextDir } from "@/lib/api";
import { SectionTitle } from "./SectionTitle";

export function ConnectionSettings() {
  const { contextDir, setContextDir } = useSettings();
  const reloadContexts = useConnections((s) => s.load);
  const [draft, setDraft] = useState(contextDir ?? "");
  const [defaultDir, setDefaultDir] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void defaultContextDir().then(setDefaultDir);
  }, []);

  const dirty = (draft.trim() || null) !== (contextDir ?? null);

  async function browse() {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setDraft(picked);
  }

  async function save() {
    setContextDir(draft.trim() ? draft.trim() : null);
    await reloadContexts();
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <>
      <SectionTitle>Connections</SectionTitle>

      <div className="space-y-2">
        <Label htmlFor="context-dir">NATS contexts directory</Label>
        <div className="flex gap-2">
          <Input
            id="context-dir"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={defaultDir ?? "~/.config/nats"}
            className="font-mono text-xs"
            spellCheck={false}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={() => void browse()}
            title="Browse…"
          >
            <FolderOpen />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Leave empty to use the default
          {defaultDir && (
            <>
              {" "}
              (<span className="font-mono">{defaultDir}</span>)
            </>
          )}
          . Point at a nats config dir or a folder of context JSON files.
        </p>

        <div className="flex items-center gap-2 pt-2">
          <Button
            variant="brand"
            size="sm"
            onClick={() => void save()}
            disabled={!dirty}
          >
            Save & reload
          </Button>
          {saved && (
            <span className="flex items-center gap-1 text-xs text-ok">
              <Check className="size-3.5" /> Saved
            </span>
          )}
        </div>
      </div>
    </>
  );
}

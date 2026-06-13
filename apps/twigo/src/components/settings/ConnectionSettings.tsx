import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Check } from "lucide-react";
import { Button, Input, Label, Switch } from "@twigo/ui";
import { useSettings } from "@/store/settings";
import { useConnections } from "@/store/connections";
import { defaultContextDir } from "@/lib/api";
import { SectionTitle } from "./SectionTitle";

export function ConnectionSettings() {
  const { contextDir, setContextDir, includeDemo, setIncludeDemo } =
    useSettings();
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

  async function toggleDemo(next: boolean) {
    setIncludeDemo(next);
    await reloadContexts();
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

      <div className="mt-6 flex items-start justify-between gap-4 border-t border-border-subtle pt-4">
        <div className="space-y-0.5">
          <Label htmlFor="demo-toggle">Public demo server</Label>
          <p className="max-w-md text-xs text-muted-foreground">
            Adds{" "}
            <span className="font-mono font-medium text-foreground">
              demo.nats.io
            </span>{" "}
            to your connections: a free public NATS server for trying core
            messages, JetStream and KV with no setup.
          </p>
        </div>
        <Switch
          id="demo-toggle"
          checked={includeDemo}
          onCheckedChange={(v) => void toggleDemo(v)}
        />
      </div>
    </>
  );
}

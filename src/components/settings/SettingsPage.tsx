import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  PlugZap,
  Palette,
  SlidersHorizontal,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUi, type Theme } from "@/store/ui";
import { useSettings } from "@/store/settings";
import { useConnections } from "@/store/connections";
import { defaultContextDir } from "@/lib/api";

type Category = "general" | "connections" | "appearance";

const categories: { id: Category; label: string; icon: typeof PlugZap }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "connections", label: "Connections", icon: PlugZap },
  { id: "appearance", label: "Appearance", icon: Palette },
];

export function SettingsPage() {
  const [category, setCategory] = useState<Category>("connections");

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-0 flex-1">
        <nav className="w-44 shrink-0 border-r border-border bg-sidebar p-2">
          {categories.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setCategory(id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent",
                category === id && "bg-accent font-medium",
              )}
            >
              <Icon className="size-4 text-muted-foreground" />
              {label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl p-6">
            {category === "general" && <GeneralSection />}
            {category === "connections" && <ConnectionsSection />}
            {category === "appearance" && <AppearanceSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-4 text-base font-semibold">{children}</h2>;
}

function GeneralSection() {
  return (
    <>
      <SectionTitle>General</SectionTitle>
      <p className="text-xs text-muted-foreground">
        More general settings will appear here.
      </p>
    </>
  );
}

function ConnectionsSection() {
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

function AppearanceSection() {
  const { theme, setTheme } = useUi();
  const options: { id: Theme; label: string }[] = [
    { id: "light", label: "Light" },
    { id: "dark", label: "Dark" },
  ];
  return (
    <>
      <SectionTitle>Appearance</SectionTitle>
      <div className="space-y-2">
        <Label>Theme</Label>
        <div className="flex gap-2">
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => setTheme(o.id)}
              className={cn(
                "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
                theme === o.id
                  ? "border-brand bg-brand/10 text-foreground"
                  : "border-input text-muted-foreground hover:bg-accent",
              )}
            >
              {theme === o.id && <Check className="size-3.5 text-brand" />}
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

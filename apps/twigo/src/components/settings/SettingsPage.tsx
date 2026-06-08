import { useState } from "react";
import { PlugZap, Palette, SlidersHorizontal, Check } from "lucide-react";
import { Label, cn } from "@twigo/ui";
import { useUi, type Theme } from "@/store/ui";
import { SectionTitle } from "./SectionTitle";
import { ConnectionSettings } from "./ConnectionSettings";

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
            {category === "connections" && <ConnectionSettings />}
            {category === "appearance" && <AppearanceSection />}
          </div>
        </div>
      </div>
    </div>
  );
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

import { Sun, Moon, PlugZap, GitBranch, Layers } from "lucide-react";
import { useUi } from "@/store/ui";

export function StatusBar() {
  const { theme, toggleTheme } = useUi();
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between bg-statusbar px-2 text-[11px] text-statusbar-foreground">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <PlugZap className="size-3.5" />
          local · connected
        </span>
        <span className="flex items-center gap-1 opacity-90">
          <GitBranch className="size-3.5" />
          RTT 2ms
        </span>
        <span className="flex items-center gap-1 opacity-90">
          <Layers className="size-3.5" />
          3 streams
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="opacity-80">Twigo v0.1.0</span>
        <button
          onClick={toggleTheme}
          title="Toggle theme"
          className="flex size-5 items-center justify-center rounded hover:bg-white/15"
        >
          {theme === "dark" ? (
            <Sun className="size-3.5" />
          ) : (
            <Moon className="size-3.5" />
          )}
        </button>
      </div>
    </footer>
  );
}

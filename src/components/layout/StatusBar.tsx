import { Sun, Moon, PlugZap, Plug, Gauge, Database } from "lucide-react";
import { useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";

export function StatusBar() {
  const { theme, toggleTheme } = useUi();
  const { activeContext, connected } = useConnections();
  const info = activeContext ? connected[activeContext] : undefined;

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between bg-statusbar px-2 text-xs text-statusbar-foreground">
      <div className="flex items-center gap-3">
        {info ? (
          <>
            <span className="flex items-center gap-1">
              <PlugZap className="size-3.5" />
              {info.name} · connected
            </span>
            <span className="flex items-center gap-1 opacity-90">
              <Gauge className="size-3.5" />
              RTT {info.rttMs.toFixed(1)}ms
            </span>
            <span className="flex items-center gap-1 opacity-90">
              <Database className="size-3.5" />
              JetStream {info.jetstream ? "on" : "off"}
            </span>
          </>
        ) : (
          <span className="flex items-center gap-1 opacity-90">
            <Plug className="size-3.5" />
            {activeContext
              ? `${activeContext} · not connected`
              : "no connection"}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="opacity-80">Twigo v0.1.0</span>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          title="Toggle theme"
          className="flex size-5 items-center justify-center rounded hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
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

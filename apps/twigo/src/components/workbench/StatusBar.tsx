import {
  Sun,
  Moon,
  PlugZap,
  Plug,
  Gauge,
  Database,
  Search,
} from "lucide-react";
import { fmtRtt } from "@twigo/utils";
import { useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";
import { usePalette } from "@/store/palette";
import { fmtBinding } from "@/lib/commands";
import { ReconnectStatus } from "./ReconnectStatus";

export function StatusBar() {
  const { theme, toggleTheme } = useUi();
  const { activeContext, connected } = useConnections();
  const info = activeContext ? connected[activeContext] : undefined;

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between bg-statusbar px-2 text-xs text-statusbar-foreground">
      <div className="flex items-center gap-3">
        {info && !info.connected ? (
          <ReconnectStatus name={info.name} />
        ) : info ? (
          <>
            <span className="flex items-center gap-1">
              <PlugZap className="size-3.5" />
              {info.name} · connected
            </span>
            <span className="flex items-center gap-1 opacity-90">
              <Gauge className="size-3.5" />
              RTT {fmtRtt(info.rttMs)}
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
        <button
          type="button"
          onClick={() => usePalette.getState().setOpen(true)}
          title="Command palette"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
        >
          <Search className="size-3" />
          <span className="opacity-90">{fmtBinding("mod+shift+p")}</span>
        </button>
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

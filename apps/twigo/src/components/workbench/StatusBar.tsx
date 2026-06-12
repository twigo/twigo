import { useEffect, useState } from "react";
import {
  Sun,
  Moon,
  PlugZap,
  Plug,
  Gauge,
  Database,
  Search,
  Activity,
} from "lucide-react";
import { fmtRtt, fmtCount } from "@twigo/utils";
import { useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";
import { useStream } from "@/store/stream";
import { usePalette } from "@/store/palette";
import { openServerInfo } from "@/lib/editor";
import { fmtBinding } from "@/lib/commands";
import { ReconnectStatus } from "./ReconnectStatus";

// Live message throughput for the active connection: count of messages landed
// across its open stream tabs in the last second, plus how many are streaming.
function useThroughput(connId: string | null) {
  const sessions = useStream((s) => s.sessions);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!connId) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [connId]);

  const mine = Object.values(sessions).filter((s) => s.connId === connId);
  const since = now - 1000;
  let rate = 0;
  for (const session of mine) {
    for (const item of session.items) {
      if (item.receivedAt >= since) rate++;
    }
  }
  return { active: mine.length, rate };
}

// Shared treatment for an interactive segment sitting on the brand-coloured bar.
const segment =
  "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors duration-100 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50";

export function StatusBar() {
  const { theme, toggleTheme } = useUi();
  const { activeContext, connected } = useConnections();
  const info = activeContext ? connected[activeContext] : undefined;
  const { active, rate } = useThroughput(info?.connected ? info.name : null);

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between bg-statusbar px-1 text-xs text-statusbar-foreground">
      <div className="flex items-center gap-0.5">
        {info && !info.connected ? (
          <span className="px-1">
            <ReconnectStatus name={info.name} />
          </span>
        ) : info ? (
          <>
            <button
              type="button"
              onClick={() => openServerInfo(info.name)}
              title="Open server info"
              className={segment}
            >
              <PlugZap className="size-3.5" />
              {info.name} · connected
            </button>
            <span className="flex items-center gap-1 px-1.5 opacity-90">
              <Gauge className="size-3.5" />
              RTT <span className="tabular-nums">{fmtRtt(info.rttMs)}</span>
            </span>
            {info.jetstream ? (
              <button
                type="button"
                onClick={() =>
                  useUi.setState({ activeView: "jetstream", sidebarOpen: true })
                }
                title="Open JetStream"
                className={segment}
              >
                <Database className="size-3.5" />
                JetStream
              </button>
            ) : (
              <span className="flex items-center gap-1 px-1.5 opacity-90">
                <Database className="size-3.5" />
                JetStream off
              </span>
            )}
            {active > 0 && (
              <span
                className="flex items-center gap-1 px-1.5 opacity-90"
                title="Messages received per second across open streams"
              >
                <Activity className="size-3.5" />
                <span className="tabular-nums">{fmtCount(rate)}/s</span>
                <span className="opacity-80">· {active} streaming</span>
              </span>
            )}
          </>
        ) : (
          <span className="flex items-center gap-1 px-1.5 opacity-90">
            <Plug className="size-3.5" />
            {activeContext
              ? `${activeContext} · not connected`
              : "no connection"}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={() => usePalette.getState().setOpen(true)}
          title="Command palette"
          className={segment}
        >
          <Search className="size-3" />
          <span className="opacity-90">{fmtBinding("mod+shift+p")}</span>
        </button>
        <span className="px-1 opacity-80">Twigo v0.1.0</span>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          title="Toggle theme"
          className="flex size-5 items-center justify-center rounded transition-colors duration-100 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
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

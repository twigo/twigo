import { useEffect, useState } from "react";
import { PlugZap, Plug, Gauge, Database, Activity } from "lucide-react";
import { fmtRtt, fmtCount } from "@twigo/utils";
import { useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";
import { useStream } from "@/store/stream";
import { openServerInfo } from "@/lib/editor";
import { statusSegmentClass } from "@/shell/statusBar";
import { ReconnectStatus } from "./ReconnectStatus";

// Live message throughput for the active connection: messages landed across its
// open stream tabs in the last second, plus how many are streaming. Rate comes
// from the delta of each session's monotonic `received` counter over the tick -
// not a per-flush scan of every retained item - and the hook reads the store
// imperatively on a 1s interval so it doesn't re-render on every batch flush.
function useThroughput(connId: string | null) {
  const [stats, setStats] = useState({ active: 0, rate: 0 });
  useEffect(() => {
    if (!connId) return;
    const mineNow = () =>
      Object.values(useStream.getState().sessions).filter(
        (s) => s.connId === connId,
      );
    let prev = mineNow().reduce((n, s) => n + s.received, 0);
    const id = setInterval(() => {
      const mine = mineNow();
      const total = mine.reduce((n, s) => n + s.received, 0);
      setStats({ active: mine.length, rate: Math.max(0, total - prev) });
      prev = total;
    }, 1000);
    return () => clearInterval(id);
  }, [connId]);
  // The null case is derived at read time, so the effect never setState's
  // synchronously (stale stats from a previous connection are never shown).
  return connId ? stats : { active: 0, rate: 0 };
}

// The NATS left-cluster of the status bar: active connection, RTT, JetStream
// capability, live throughput, or the reconnect countdown while a link is down.
export function NatsConnectionStatus() {
  const { activeContext, connected } = useConnections();
  const info = activeContext ? connected[activeContext] : undefined;
  const { active, rate } = useThroughput(info?.connected ? info.name : null);

  if (info && !info.connected) {
    return (
      <span className="px-1">
        <ReconnectStatus name={info.name} />
      </span>
    );
  }
  if (info) {
    return (
      <>
        <button
          type="button"
          onClick={() => openServerInfo(info.name)}
          title="Open server info"
          className={statusSegmentClass}
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
            className={statusSegmentClass}
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
    );
  }
  return (
    <span className="flex items-center gap-1 px-1.5 opacity-90">
      <Plug className="size-3.5" />
      {activeContext ? `${activeContext} · not connected` : "no connection"}
    </span>
  );
}

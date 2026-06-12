import { useEffect, useState } from "react";
import { PlugZap, Plug, Gauge, Database, Activity } from "lucide-react";
import { fmtRtt, fmtCount } from "@twigo/utils";
import { useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";
import { useStream } from "@/store/stream";
import { openServerInfo } from "@/lib/editor";
import { statusSegmentClass } from "@/shell/statusBar";
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

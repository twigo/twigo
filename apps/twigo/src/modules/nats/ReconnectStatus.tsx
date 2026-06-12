import { useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { useConnections } from "@/store/connections";

export function ReconnectStatus({ name }: { name: string }) {
  const rc = useConnections((s) => s.reconnecting[name]);
  // `now` is state (not Date.now() in render) so the countdown re-renders on
  // tick without an impure render call; only mounted while disconnected.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const remaining = rc ? Math.max(0, rc.at + rc.delayMs - now) : 0;
  const secs = Math.ceil(remaining / 1000);

  return (
    <span className="flex items-center gap-1">
      <Plug className="size-3.5 animate-pulse" />
      {name} · reconnecting
      {rc && (
        <span className="opacity-80">
          {` · attempt ${String(rc.attempt)}`}
          {remaining > 0 ? ` · next try in ${String(secs)}s` : " · trying…"}
        </span>
      )}
    </span>
  );
}

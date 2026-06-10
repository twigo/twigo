import { Circle, Loader2 } from "lucide-react";
import { cn } from "@twigo/ui";
import type { ConnInfo } from "@/lib/api";

export function StatusGlyph({
  info,
  connecting,
  error,
}: {
  info: ConnInfo | undefined;
  connecting?: boolean;
  error?: boolean;
}) {
  if (connecting) {
    return (
      <Loader2 className="size-2.5 shrink-0 animate-spin text-muted-foreground" />
    );
  }
  const isLive = info?.connected === true;
  const isConnected = !!info;
  return (
    <Circle
      aria-hidden
      className={cn(
        "size-2 shrink-0",
        isLive
          ? "fill-ok text-ok"
          : isConnected
            ? "animate-pulse fill-warn text-warn"
            : error
              ? "fill-error text-error"
              : "fill-muted-foreground/40 text-muted-foreground/40",
      )}
    />
  );
}

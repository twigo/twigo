import { Circle, Loader2 } from "lucide-react";
import { cn } from "@twigo/ui";
import { type ConnInfo } from "@/lib/api";
import { linkState, type LinkState } from "./linkState";

const GLYPH: Record<Exclude<LinkState, "dialling">, string> = {
  live: "fill-ok text-ok",
  reconnecting: "animate-pulse fill-warn text-warn",
  failed: "fill-error text-error",
  offline: "fill-muted-foreground/40 text-muted-foreground/40",
};

export function StatusGlyph({
  info,
  connecting,
  error,
}: {
  info: ConnInfo | undefined;
  connecting?: boolean;
  error?: boolean;
}) {
  const state = linkState(info, !!connecting, !!error);
  if (state === "dialling") {
    return (
      <Loader2 className="size-2.5 shrink-0 animate-spin text-muted-foreground" />
    );
  }
  return <Circle aria-hidden className={cn("size-2 shrink-0", GLYPH[state])} />;
}

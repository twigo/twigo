import { Radio, Send, Search, Settings } from "lucide-react";
import { EmptyState, Kbd } from "@twigo/ui";
import { useConnections } from "@/store/connections";
import { usePalette } from "@/store/palette";
import { openSettings } from "@/lib/editor";
import { fmtBinding } from "@/lib/commands";
import { newPublish } from "@/lib/actions";

// The NATS editor watermark. Branches on whether anything is live so the first
// thing a new user sees is a way forward, not a dead end. Contributed to the
// shell's watermark slot by registerNatsModule().
export function NatsWatermark() {
  const noContexts = useConnections(
    (s) => s.status === "ready" && s.contexts.length === 0,
  );
  const hasLive = useConnections((s) =>
    Object.values(s.connected).some((i) => i.connected),
  );
  if (noContexts) {
    return (
      <EmptyState
        icon={Radio}
        className="h-full bg-background"
        title="No connections yet"
        action={{
          label: "Open settings",
          onClick: () => openSettings(),
          icon: Settings,
        }}
        kbd={fmtBinding("mod+,")}
      >
        <p className="max-w-sm">
          Twigo reads your nats CLI contexts from{" "}
          <code className="font-mono text-xs">~/.config/nats/context</code>. Add
          one with <code className="font-mono text-xs">nats context add</code>,
          or point Twigo at a different folder in Settings.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          New here? Press <Kbd>?</Kbd> for keyboard shortcuts.
        </p>
      </EmptyState>
    );
  }
  if (!hasLive) {
    return (
      <EmptyState
        icon={Radio}
        className="h-full bg-background"
        title="No live connection"
        action={{
          label: "Open command palette",
          onClick: () => usePalette.getState().setOpen(true),
          icon: Search,
        }}
        kbd={fmtBinding("mod+shift+p")}
      >
        <p className="max-w-xs">
          Connect to a server from the switcher in the top-left, then pick a
          subject to watch it live.
        </p>
      </EmptyState>
    );
  }
  return (
    <EmptyState
      icon={Radio}
      className="h-full bg-background"
      title="Pick a subject to stream"
      action={{ label: "New publish", onClick: () => newPublish(), icon: Send }}
    >
      <p className="max-w-xs">
        Choose a subject in the Explorer - each opens in its own live tab.
      </p>
    </EmptyState>
  );
}

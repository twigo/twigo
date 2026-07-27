import { useState } from "react";
import { Radio, Send, Search, Plus } from "lucide-react";
import { EmptyState, Kbd } from "@twigo/ui";
import { useConnections, selectAnyLive } from "@/store/connections";
import { useSettings } from "@/store/settings";
import { usePalette } from "@/store/palette";
import { openSettings } from "@/shell/editorHost";
import { fmtBinding } from "@/lib/commands";
import { newPublish } from "@/lib/actions";
import { ConnectionForm } from "@/components/connections/ConnectionForm";

// The NATS editor watermark. Branches on whether anything is live so the first
// thing a new user sees is a way forward, not a dead end. Contributed to the
// shell's watermark slot by registerNatsModule().
export function NatsWatermark() {
  const [addOpen, setAddOpen] = useState(false);
  const noContexts = useConnections(
    (s) => s.status === "ready" && s.contexts.length === 0,
  );
  const hasLive = useConnections(selectAnyLive);

  const tryDemo = () => {
    useSettings.getState().setIncludeDemo(true);
    void useConnections.getState().load();
  };

  if (noContexts) {
    return (
      <>
        <EmptyState
          icon={Radio}
          className="h-full bg-background"
          title="No connections yet"
          action={{
            label: "Add connection…",
            onClick: () => setAddOpen(true),
            icon: Plus,
          }}
        >
          <p className="max-w-sm">
            No server handy?{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={tryDemo}
            >
              Try the public demo server
            </button>{" "}
            - zero setup.
          </p>
          <p className="mt-2 max-w-sm">
            Twigo also imports your nats CLI contexts from{" "}
            <code className="font-mono text-xs">~/.config/nats/context</code>;
            point it at a different folder in{" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:text-foreground"
              onClick={() => openSettings()}
            >
              Settings
            </button>
            .
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            New here? Press <Kbd>?</Kbd> for keyboard shortcuts.
          </p>
        </EmptyState>
        {addOpen && (
          <ConnectionForm editName={null} onClose={() => setAddOpen(false)} />
        )}
      </>
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

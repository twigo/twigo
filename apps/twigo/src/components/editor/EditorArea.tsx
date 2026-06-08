import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Radio, Send } from "lucide-react";
import { Button, EmptyState } from "@twigo/ui";
import { useUi } from "@/store/ui";
import { useStream } from "@/store/stream";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { setEditorApi, openStream } from "@/lib/editor";
import { newPublish } from "@/lib/actions";
import { editorComponents, editorTabComponents } from "./registry";
import { NewTabButton } from "./NewTabButton";

// Shown by Dockview when the editor area has no open tabs.
function Watermark() {
  const hasLive = useConnections((s) =>
    Object.values(s.connected).some((i) => i.connected),
  );
  return (
    <EmptyState icon={Radio} className="h-full bg-background">
      <p>Select a subject in the Explorer to start a live stream.</p>
      <p className="text-xs opacity-80">Each subject opens in its own tab.</p>
      <Button
        variant="outline"
        size="sm"
        className="mt-2"
        disabled={!hasLive}
        onClick={() => newPublish()}
      >
        <Send />
        New publish
      </Button>
    </EmptyState>
  );
}

// A restored stream tab comes back as a placeholder (no live session). Subscribe
// it lazily once it's the focused tab and its connection is truly live.
function subscribeActiveStream(api: DockviewApi) {
  const panel = api.activePanel;
  if (!panel) return;
  const p = panel.params as {
    type?: string;
    connId?: string;
    subject?: string;
  };
  if (p.type !== "stream" || !p.connId || !p.subject) return;
  if (useStream.getState().sessions[panel.id]) return; // already live
  if (!useConnections.getState().connected[p.connId]?.connected) return; // not up
  void openStream(p.connId, p.subject);
}

export function EditorArea() {
  const uiTheme = useUi((s) => s.theme);
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const theme = useMemo<DockviewTheme>(() => {
    const base = uiTheme === "dark" ? themeDark : themeLight;
    return {
      ...base,
      className: `${base.className} twigo-dockview`,
      gap: 0,
      tabAnimation: "smooth",
    };
  }, [uiTheme]);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    apiRef.current = api;
    setEditorApi(api);

    // Restore the previous session's tabs/layout. On a bad/old blob fall back
    // to an empty area rather than letting fromJSON throw and brick startup.
    const saved = useWorkspace.getState().layout;
    if (saved) {
      try {
        api.fromJSON(saved);
      } catch {
        api.clear();
      }
    }

    // These dockview listeners are disposed with the api on unmount.
    api.onDidActivePanelChange((panel) => {
      subscribeActiveStream(api);
      const id = panel?.id;
      useStream
        .getState()
        .setActive(id && useStream.getState().sessions[id] ? id : null);
    });

    api.onDidRemovePanel((panel) => {
      if (useStream.getState().sessions[panel.id]) {
        void useStream.getState().close(panel.id);
      }
    });

    api.onDidLayoutChange(() => {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        useWorkspace.getState().setLayout(api.toJSON());
      }, 300);
    });

    subscribeActiveStream(api);
  }, []);

  // Wake the focused restored stream tab when a connection comes online.
  // Tied to the component lifecycle so it doesn't leak across remounts.
  useEffect(() => {
    const unsub = useConnections.subscribe(() => {
      if (apiRef.current) subscribeActiveStream(apiRef.current);
    });
    return () => {
      unsub();
      clearTimeout(saveTimerRef.current);
    };
  }, []);

  return (
    <DockviewReact
      className="h-full"
      theme={theme}
      dndStrategy="pointer"
      disableFloatingGroups
      watermarkComponent={Watermark}
      rightHeaderActionsComponent={NewTabButton}
      onReady={onReady}
      components={editorComponents}
      tabComponents={editorTabComponents}
    />
  );
}

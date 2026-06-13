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
import { useUi } from "@/store/ui";
import { useStream } from "@/store/stream";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import {
  setEditorApi,
  openStream,
  isReplacingLayout,
  setReplacingLayout,
  closeEditorsForConn,
} from "@/lib/editor";
import { getWatermark } from "@/shell/watermark";
import { editorComponents, editorTabComponents } from "./registry";
import { NewTabButton } from "./NewTabButton";

// Fallback for the editor zero-state when no domain module contributed a
// watermark (the NATS module registers its own via registerNatsModule).
function EmptyWatermark() {
  return <div className="h-full bg-editor" />;
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
  const uiTheme = useUi((s) => s.resolvedTheme);
  // Resolved at render (after registerNatsModule ran in main.tsx); stable after.
  const Watermark = getWatermark() ?? EmptyWatermark;
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // The connection whose tab layout is currently shown; layouts are per-context
  // and swapped when the active connection changes.
  const shownRef = useRef<string>("");

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
    // Inject editor teardown into the connections store (keeps store→UI
    // dependency one-way; the store calls this when a connection drops).
    useConnections.getState().setEditorTeardown(closeEditorsForConn);

    // Restore the active connection's tabs/layout. On a bad/old blob fall back
    // to an empty area rather than letting fromJSON throw and brick startup.
    shownRef.current = useConnections.getState().activeContext ?? "";
    const saved = useWorkspace.getState().layouts[shownRef.current];
    if (saved) {
      try {
        api.fromJSON(saved);
      } catch {
        api.clear();
      }
    }

    // These dockview listeners are disposed with the api on unmount. They all
    // bail while a layout swap/teardown is in flight, so bulk panel removals
    // don't tear down live streams or persist an empty layout.
    api.onDidActivePanelChange((panel) => {
      if (isReplacingLayout()) return;
      subscribeActiveStream(api);
      const id = panel?.id;
      useStream
        .getState()
        .setActive(id && useStream.getState().sessions[id] ? id : null);
    });

    api.onDidRemovePanel((panel) => {
      if (isReplacingLayout()) return;
      if (useStream.getState().sessions[panel.id]) {
        void useStream.getState().close(panel.id);
      }
    });

    api.onDidLayoutChange(() => {
      if (isReplacingLayout()) return;
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = undefined;
        useWorkspace.getState().setLayout(shownRef.current, api.toJSON());
      }, 300);
    });

    subscribeActiveStream(api);
  }, []);

  // Swap the editor layout when the active connection changes (tabs are
  // per-context), and wake the focused restored stream as connections come up.
  useEffect(() => {
    const unsub = useConnections.subscribe((s) => {
      const api = apiRef.current;
      if (!api) return;
      const conn = s.activeContext ?? "";
      if (conn !== shownRef.current) {
        setReplacingLayout(true);
        try {
          useWorkspace.getState().setLayout(shownRef.current, api.toJSON());
          shownRef.current = conn;
          api.clear();
          const next = useWorkspace.getState().layouts[conn];
          if (next) {
            try {
              api.fromJSON(next);
            } catch {
              api.clear();
            }
          }
        } finally {
          setReplacingLayout(false);
        }
      }
      subscribeActiveStream(api);
    });

    // Flush a pending (debounced) layout save before the window closes, so
    // quitting right after a layout change doesn't lose it.
    const flushOnExit = () => {
      const api = apiRef.current;
      if (!api || isReplacingLayout() || saveTimerRef.current === undefined) {
        return;
      }
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
      useWorkspace.getState().setLayout(shownRef.current, api.toJSON());
    };
    window.addEventListener("beforeunload", flushOnExit);

    return () => {
      unsub();
      window.removeEventListener("beforeunload", flushOnExit);
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

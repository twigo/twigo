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
import { Radio, Send, Search } from "lucide-react";
import { EmptyState } from "@twigo/ui";
import { useUi } from "@/store/ui";
import { useStream } from "@/store/stream";
import { useConnections } from "@/store/connections";
import { usePalette } from "@/store/palette";
import { fmtBinding } from "@/lib/commands";
import { useWorkspace } from "@/store/workspace";
import {
  setEditorApi,
  openStream,
  isReplacingLayout,
  setReplacingLayout,
  closeEditorsForConn,
} from "@/lib/editor";
import { newPublish } from "@/lib/actions";
import { TwigMascot } from "@/components/TwigMascot";
import { editorComponents, editorTabComponents } from "./registry";
import { NewTabButton } from "./NewTabButton";

// Shown by Dockview when the editor area has no open tabs. Branches on whether
// anything is live so the first thing a new user sees is a way forward, not a
// dead end.
function Watermark() {
  const hasLive = useConnections((s) =>
    Object.values(s.connected).some((i) => i.connected),
  );
  if (!hasLive) {
    return (
      <EmptyState
        visual={<TwigMascot className="mb-1 size-20" />}
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
        Choose a subject in the Explorer — each opens in its own live tab.
      </p>
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

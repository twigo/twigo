import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "@/components/workbench/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { applyTheme, useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";
import { useSubjects } from "@/store/subjects";
import { useWorkspace } from "@/store/workspace";
import { useAppHydrated } from "@/lib/hydration";
import type { NatsEvent, SubjectsUpdate } from "@/lib/api";

function Workbench() {
  const loadContexts = useConnections((s) => s.load);
  const onEvent = useConnections((s) => s.onEvent);
  const updateSubjects = useSubjects((s) => s.update);

  // Load contexts, then restore the previous session: reconnect the saved
  // connections and resume their subject watches. The editor area (Dockview)
  // restores its own tabs/layout and re-subscribes streams lazily on focus.
  useEffect(() => {
    let cancelled = false;
    void loadContexts().then(() => {
      if (cancelled) return;
      const { connect } = useConnections.getState();
      const { startWatch } = useSubjects.getState();
      for (const name of useWorkspace.getState().lastConnected) {
        void connect(name).then(() => {
          const pattern = useWorkspace.getState().watching[name];
          if (pattern && !useSubjects.getState().watching[name]) {
            void startWatch(name, pattern);
          }
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadContexts]);

  useEffect(() => {
    const unlisten = listen<NatsEvent>("nats:event", (e) => {
      onEvent(e.payload.conn, e.payload.kind);
    });
    return () => {
      void unlisten.then((fn) => {
        fn();
      });
    };
  }, [onEvent]);

  useEffect(() => {
    const unlisten = listen<SubjectsUpdate>("subjects:update", (e) => {
      updateSubjects(e.payload.conn, e.payload.subjects, e.payload.truncated);
    });
    return () => {
      void unlisten.then((fn) => {
        fn();
      });
    };
  }, [updateSubjects]);

  return <AppShell />;
}

function App() {
  const theme = useUi((s) => s.theme);
  const hydrated = useAppHydrated();

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <ErrorBoundary>
      {hydrated ? <Workbench /> : <div className="h-full bg-background" />}
    </ErrorBoundary>
  );
}

export default App;

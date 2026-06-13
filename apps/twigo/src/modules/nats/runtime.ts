import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useConnections } from "@/store/connections";
import { useSubjects } from "@/store/subjects";
import { useWorkspace } from "@/store/workspace";
import { setWindowTitle } from "@/shell/title";
import type { NatsEvent, ReconnectEvent, SubjectsUpdate } from "@/lib/api";

// The NATS module's runtime wiring: restore the previous session and bridge
// backend nats:* events into the stores. Called once from the workbench root so
// the shell (App.tsx) imports no connection/subject state of its own - a second
// domain would expose its own useXyzRuntime() the same way.
export function useNatsRuntime(): void {
  const loadContexts = useConnections((s) => s.load);
  const onEvent = useConnections((s) => s.onEvent);
  const onReconnect = useConnections((s) => s.onReconnect);
  const updateSubjects = useSubjects((s) => s.update);
  const activeContext = useConnections((s) => s.activeContext);

  // Reflect the active connection in the window/document title - the shell owns
  // the "Twigo" base, the NATS module supplies the context as the suffix.
  useEffect(() => {
    setWindowTitle(activeContext);
  }, [activeContext]);

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
      onEvent(e.payload.conn, e.payload.kind, e.payload.detail ?? null);
    });
    return () => {
      void unlisten.then((fn) => {
        fn();
      });
    };
  }, [onEvent]);

  useEffect(() => {
    const unlisten = listen<ReconnectEvent>("nats:reconnect", (e) => {
      onReconnect(e.payload.conn, e.payload.attempt, e.payload.delayMs);
    });
    return () => {
      void unlisten.then((fn) => {
        fn();
      });
    };
  }, [onReconnect]);

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
}

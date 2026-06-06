import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { AppShell } from "@/components/layout/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { applyTheme, useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";
import { useSubjects } from "@/store/subjects";
import type { NatsEvent, SubjectsUpdate } from "@/lib/api";

function App() {
  const theme = useUi((s) => s.theme);
  const loadContexts = useConnections((s) => s.load);
  const onEvent = useConnections((s) => s.onEvent);
  const updateSubjects = useSubjects((s) => s.update);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    void loadContexts();
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

  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}

export default App;

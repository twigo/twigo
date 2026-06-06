import { useEffect } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { applyTheme, useUi } from "@/store/ui";
import { useConnections } from "@/store/connections";

function App() {
  const theme = useUi((s) => s.theme);
  const loadContexts = useConnections((s) => s.load);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    loadContexts();
  }, [loadContexts]);

  return <AppShell />;
}

export default App;

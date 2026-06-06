import { useEffect } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { applyTheme, useUi } from "@/store/ui";

function App() {
  const theme = useUi((s) => s.theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return <AppShell />;
}

export default App;

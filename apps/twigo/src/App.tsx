import { useEffect } from "react";
import { AppShell } from "@/components/workbench/AppShell";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { applyTheme, useUi } from "@/store/ui";
import { applyZoom, useZoom } from "@/store/zoom";
import { useAppHydrated } from "@/lib/hydration";
import { useNatsRuntime } from "@/modules/nats/runtime";

function Workbench() {
  useNatsRuntime();
  return <AppShell />;
}

function App() {
  const themeChoice = useUi((s) => s.theme);
  const resolvedTheme = useUi((s) => s.resolvedTheme);
  const zoom = useZoom((s) => s.factor);
  const hydrated = useAppHydrated();

  // Re-resolve when the choice changes (also covers post-hydration) and, while
  // on "system", follow the OS appearance live.
  useEffect(() => {
    useUi.getState().syncResolvedTheme();
    if (themeChoice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => useUi.getState().syncResolvedTheme();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [themeChoice]);

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    applyZoom(zoom);
  }, [zoom]);

  return (
    <ErrorBoundary>
      {hydrated ? <Workbench /> : <div className="h-full bg-background" />}
    </ErrorBoundary>
  );
}

export default App;

import { useCallback, useEffect, useRef } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { ActivityBar } from "./ActivityBar";
import { StatusBar } from "./StatusBar";
import { EditorArea } from "./EditorArea";
import { Sidebar } from "./Sidebar";
import { DetailPanel } from "./DetailPanel";
import { useUi } from "@/store/ui";

export function AppShell() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const detailOpen = useUi((s) => s.detailOpen);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const toggleDetail = useUi((s) => s.toggleDetail);
  const shellSizes = useUi((s) => s.shellSizes);
  const setShellSizes = useUi((s) => s.setShellSizes);

  // Persist pane sizes, debounced so a drag doesn't thrash localStorage.
  // Skip arrays containing a 0 — Allotment reports 0 for a hidden pane, which
  // would otherwise reopen it collapsed on the next launch.
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persistSizes = useCallback(
    (sizes: number[]) => {
      if (!sizes.every((n) => n > 0)) return;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setShellSizes(sizes);
      }, 150);
    },
    [setShellSizes],
  );

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // VS Code-style layout toggles: Cmd/Ctrl+B (sidebar), Cmd/Ctrl+Alt+B (inspector).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (e.altKey) toggleDetail();
        else toggleSidebar();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [toggleSidebar, toggleDetail]);

  const restored =
    shellSizes.length === 3 && shellSizes.every((n) => n > 0)
      ? shellSizes
      : undefined;

  return (
    <div className="flex h-full flex-col border-t border-border">
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <Allotment
          className="min-w-0 flex-1"
          defaultSizes={restored}
          onChange={persistSizes}
        >
          <Allotment.Pane
            minSize={180}
            preferredSize={280}
            visible={sidebarOpen}
          >
            <Sidebar />
          </Allotment.Pane>
          <Allotment.Pane minSize={320}>
            <EditorArea />
          </Allotment.Pane>
          <Allotment.Pane
            minSize={240}
            preferredSize={360}
            visible={detailOpen}
          >
            <DetailPanel />
          </Allotment.Pane>
        </Allotment>
      </div>
      <StatusBar />
    </div>
  );
}

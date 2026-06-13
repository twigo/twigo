import { useCallback, useEffect, useRef } from "react";
import { Allotment } from "allotment";
import "allotment/dist/style.css";
import { ActivityBar } from "./ActivityBar";
import { StatusBar } from "./StatusBar";
import { Toaster } from "./Toaster";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsHelp } from "./ShortcutsHelp";
import { EditorArea } from "@/components/editor/EditorArea";
import { Sidebar } from "@/components/views/Sidebar";
import { useUi } from "@/store/ui";

export function AppShell() {
  const sidebarOpen = useUi((s) => s.sidebarOpen);
  const shellSizes = useUi((s) => s.shellSizes);
  const setShellSizes = useUi((s) => s.setShellSizes);

  // Persist pane sizes, debounced so a drag doesn't thrash localStorage.
  // Skip arrays containing a 0 - Allotment reports 0 for a hidden pane, which
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

  const restored =
    shellSizes.length === 2 && shellSizes.every((n) => n > 0)
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
        </Allotment>
      </div>
      <StatusBar />
      <Toaster />
      <CommandPalette />
      <ShortcutsHelp />
    </div>
  );
}

import { useMemo } from "react";
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewReadyEvent,
  type DockviewTheme,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Radio } from "lucide-react";
import { useUi } from "@/store/ui";
import { useStream } from "@/store/stream";
import { setEditorApi } from "@/lib/editor";
import { editorComponents, editorTabComponents } from "./editors";

// Shown by Dockview when the editor area has no open tabs.
function Watermark() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-background px-6 text-center text-sm text-muted-foreground">
      <Radio className="size-8 opacity-30" />
      <p>Select a subject in the Explorer to start a live stream.</p>
      <p className="text-xs opacity-80">Each subject opens in its own tab.</p>
    </div>
  );
}

function onReady(event: DockviewReadyEvent) {
  const api = event.api;
  setEditorApi(api);

  // The detail panel tracks the visible editor: the active stream tab, or
  // nothing when a non-stream tab (settings/server) or no tab is focused.
  api.onDidActivePanelChange((panel) => {
    const id = panel?.id;
    useStream
      .getState()
      .setActive(id && useStream.getState().sessions[id] ? id : null);
  });

  // Closing a stream tab stops its subscription.
  api.onDidRemovePanel((panel) => {
    if (useStream.getState().sessions[panel.id]) {
      void useStream.getState().close(panel.id);
    }
  });
}

export function EditorArea() {
  const uiTheme = useUi((s) => s.theme);

  const theme = useMemo<DockviewTheme>(() => {
    const base = uiTheme === "dark" ? themeDark : themeLight;
    return {
      ...base,
      className: `${base.className} twigo-dockview`,
      gap: 0,
      tabAnimation: "smooth",
    };
  }, [uiTheme]);

  return (
    <DockviewReact
      className="h-full"
      theme={theme}
      dndStrategy="pointer"
      disableFloatingGroups
      watermarkComponent={Watermark}
      onReady={onReady}
      components={editorComponents}
      tabComponents={editorTabComponents}
    />
  );
}

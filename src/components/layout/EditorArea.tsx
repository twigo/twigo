import { useMemo } from "react";
import {
  DockviewReact,
  themeDark,
  themeLight,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Radio, X, Settings, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUi } from "@/store/ui";
import { useStream } from "@/store/stream";
import { setEditorApi } from "@/lib/editor";
import { MessageStream } from "./MessageStream";
import { ServerInfoPanel } from "./ServerInfoPanel";
import { SettingsPage } from "@/components/settings/SettingsPage";

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

const components: Record<string, React.FC<IDockviewPanelProps>> = {
  stream: (props) => {
    const { streamId } = props.params as { streamId: string };
    return <MessageStream streamId={streamId} />;
  },
  settings: () => <SettingsPage />,
  server: (props) => {
    const { connId } = props.params as { connId: string };
    return <ServerInfoPanel connId={connId} />;
  },
};

// Closable editor tab: leading icon, title, and a close button that only
// appears on the active/hovered tab (styled in index.css via .twigo-tab-close).
function closableTab(
  Icon: typeof Radio,
  opts?: { iconClass?: string; mono?: boolean },
) {
  return function Tab(props: IDockviewPanelHeaderProps) {
    return (
      <div className="flex h-full items-center gap-2 pl-3 pr-2 text-xs">
        <Icon className={cn("size-3 shrink-0", opts?.iconClass)} />
        <span className={cn("max-w-44 truncate", opts?.mono && "font-mono")}>
          {props.api.title}
        </span>
        <button
          type="button"
          aria-label="Close tab"
          title="Close tab"
          onClick={(e) => {
            e.stopPropagation();
            props.api.close();
          }}
          className="twigo-tab-close flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>
    );
  };
}

const tabComponents: Record<string, React.FC<IDockviewPanelHeaderProps>> = {
  stream: closableTab(Radio, { iconClass: "text-brand", mono: true }),
  settings: closableTab(Settings, { iconClass: "text-muted-foreground" }),
  server: closableTab(Server, { iconClass: "text-brand", mono: true }),
};

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
      components={components}
      tabComponents={tabComponents}
    />
  );
}

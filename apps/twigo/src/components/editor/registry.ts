import type { FC } from "react";
import type {
  IDockviewPanelProps,
  IDockviewPanelHeaderProps,
} from "dockview-react";
import { useStream } from "@/store/stream";
import { useResponder } from "@/store/responder";
import {
  StreamPanel,
  ServerPanel,
  PublishPanel,
  ResponderPanel,
  SettingsPanel,
  StreamTab,
  ServerTab,
  PublishTab,
  ResponderTab,
  SettingsTab,
} from "./panels";

// Editor inputs (VS Code model). One registry drives the Dockview component &
// tab maps and connection-scoped teardown, so a new tab type is a single entry
// and an omission is a compile error (Record<EditorType, …>).
export type EditorType =
  | "stream"
  | "settings"
  | "server"
  | "publish"
  | "responder";

interface EditorDef {
  component: FC<IDockviewPanelProps>;
  tab: FC<IDockviewPanelHeaderProps>;
  // Conn-scoped tabs are closed when their connection drops.
  connScoped?: boolean;
  // Release any non-Dockview resource bound to the panel (e.g. a subscription).
  dispose?: (panelId: string) => void;
}

export const EDITORS: Record<EditorType, EditorDef> = {
  stream: {
    component: StreamPanel,
    tab: StreamTab,
    connScoped: true,
    dispose: (id) => {
      void useStream.getState().close(id);
    },
  },
  server: { component: ServerPanel, tab: ServerTab, connScoped: true },
  publish: { component: PublishPanel, tab: PublishTab, connScoped: true },
  responder: {
    component: ResponderPanel,
    tab: ResponderTab,
    connScoped: true,
    dispose: (id) => {
      useResponder.getState().remove(id);
    },
  },
  settings: { component: SettingsPanel, tab: SettingsTab },
};

export const editorComponents: Record<
  string,
  FC<IDockviewPanelProps>
> = Object.fromEntries(
  Object.entries(EDITORS).map(([type, def]) => [type, def.component]),
);

export const editorTabComponents: Record<
  string,
  FC<IDockviewPanelHeaderProps>
> = Object.fromEntries(
  Object.entries(EDITORS).map(([type, def]) => [type, def.tab]),
);

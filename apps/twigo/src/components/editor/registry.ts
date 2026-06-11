import type { FC } from "react";
import type {
  IDockviewPanelProps,
  IDockviewPanelHeaderProps,
} from "dockview-react";
import { useStream } from "@/store/stream";
import {
  StreamPanel,
  ServerPanel,
  PublishPanel,
  ResponderPanel,
  SettingsPanel,
  JsStreamPanel,
  JsConsumerPanel,
  KvEntryPanel,
  ObjectPanel,
  StreamTab,
  ServerTab,
  PublishTab,
  ResponderTab,
  SettingsTab,
  JsStreamTab,
  JsConsumerTab,
  KvEntryTab,
  ObjectTab,
} from "./panels";

// Editor inputs (VS Code model). One registry drives the Dockview component &
// tab maps and connection-scoped teardown, so a new tab type is a single entry
// and an omission is a compile error (Record<EditorType, …>).
export type EditorType =
  | "stream"
  | "settings"
  | "server"
  | "publish"
  | "responder"
  | "jsstream"
  | "jsconsumer"
  | "kventry"
  | "objentry";

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
  // Responders are managed from the Responders view, not the tab: closing the
  // tab leaves the mock running. The session is torn down on conn loss
  // (closeEditorsForConn) or explicit delete, so there's no per-tab dispose.
  responder: { component: ResponderPanel, tab: ResponderTab, connScoped: true },
  settings: { component: SettingsPanel, tab: SettingsTab },
  jsstream: { component: JsStreamPanel, tab: JsStreamTab, connScoped: true },
  jsconsumer: {
    component: JsConsumerPanel,
    tab: JsConsumerTab,
    connScoped: true,
  },
  kventry: { component: KvEntryPanel, tab: KvEntryTab, connScoped: true },
  objentry: { component: ObjectPanel, tab: ObjectTab, connScoped: true },
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

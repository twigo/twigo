export type { Command, CommandDescriptor } from "./commands/registry";
export type { MenuId, MenuItem } from "./commands/menus";
export type { Scope } from "./contextkey/service";
export type { ContextValue } from "./contextkey/when";
export type { EditorProps, EditorProvider } from "./editors/registry";
export type { Platform } from "./keybindings/chord";
export { platformOf } from "./keybindings/platform";
export type { KeybindingRule } from "./keybindings/resolver";
export { Changes } from "./changes";
export { useChanges, useWorkbench } from "./react";
export { createWorkbench, Workbench } from "./services";
export type {
  Location,
  StatusBarItem,
  View,
  ViewContainer,
} from "./views/registry";
export { WorkbenchView } from "./WorkbenchView";

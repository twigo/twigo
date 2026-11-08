export type { Command, CommandDescriptor } from "./commands/registry";
export type { MenuId, MenuItem } from "./commands/menus";
export {
  nativeMenus,
  type NativeMenu,
  type NativeMenuItem,
} from "./commands/nativeMenu";
export type { Scope } from "./contextkey/service";
export type { ContextValue, Lookup } from "./contextkey/when";
export type { EditorProps, EditorProvider } from "./editors/registry";
export type { RecentEditor, RecentEditors } from "./editors/recent";
export type { ListTarget } from "./lists/service";
export { useListRegistration } from "./lists/react";
export type { Platform } from "./keybindings/chord";
export { platformOf } from "./keybindings/platform";
export type { KeybindingRule } from "./keybindings/resolver";
export { Changes } from "./changes";
export { useChanges, useWorkbench } from "./react";
export type {
  AcceptOptions,
  PickSource,
  Picked,
  QuickAccessContext,
  QuickAccessProvider,
  QuickPickItem,
} from "./quickaccess/registry";
export { filtered } from "./quickaccess/providers";
export { createWorkbench, Workbench } from "./services";
export type { Look, Outcome } from "./operations/service";
export { StateStore } from "./state/store";
export type { SpaceConnection, SpaceStatusProvider } from "./spaces/status";
export type {
  Location,
  StatusBarItem,
  StatusEntry,
  View,
  ViewContainer,
  Watermark,
} from "./views/registry";
export { SpaceTile } from "./parts/SpaceTile";
export {
  accessOfSpace,
  chipLabel,
  describeAccess,
  setByPolicyFile,
} from "./spaces/modes";
export { WorkbenchView } from "./WorkbenchView";

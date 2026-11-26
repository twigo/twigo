export type { Command, CommandDescriptor } from "./commands/registry";
export type { MenuId, MenuItem } from "./commands/menus";
export {
  nativeMenus,
  type NativeMenu,
  type NativeMenuItem,
} from "./commands/nativeMenu";
export type { Scope } from "./contextkey/service";
export type { ContextValue, Lookup } from "./contextkey/when";
export type {
  EditorProps,
  EditorProvider,
  SessionState,
} from "./editors/registry";
export type { RecentEditor, RecentEditors } from "./editors/recent";
export type { ListTarget } from "./lists/service";
export { useListRegistration } from "./lists/react";
export type { Platform } from "./keybindings/chord";
export { platformOf } from "./keybindings/platform";
export type { KeybindingRule } from "./keybindings/resolver";
export { Changes } from "./changes";
export { STRIP_KEPT } from "./parts/strip";
export {
  EditorShownContext,
  useActionRoom,
  useChanges,
  useEditorShown,
  useWorkbench,
} from "./react";
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
export {
  errorDetails,
  errorOneLine,
  errorText,
  type ErrorLike,
} from "./errors";
export { ErrorBanner } from "./ErrorBanner";
export { ErrorMessage } from "./ErrorMessage";
export { INTERNAL_ERROR, isInternalError } from "./internalError";
export { REPORT_PROBLEM } from "./report/commands";
export { ReportButton, ReportLink } from "./report/ReportLink";
export { notifyError } from "./notifyError";
export type { Look, Outcome } from "./operations/service";
export { canUnlock, unlockAction } from "./operations/unlock";
export { StateStore } from "./state/store";
export { SET_CONTEXT_ENVIRONMENT } from "./spaces/modeCommands";
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
export { spaceMark } from "./parts/spaceMark";
export {
  accessOfSpace,
  chipLabel,
  describeAccess,
  modeLabel,
  setByPolicyFile,
} from "./spaces/modes";
export { ALL_NAMESPACES, scopeNames, scopeWords } from "./spaces/scope";
export { WorkbenchView } from "./WorkbenchView";

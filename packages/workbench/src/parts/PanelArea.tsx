import { useEffect, useRef, useState } from "react";
import {
  themeLight,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
} from "dockview-react";
import { PanelBottom } from "lucide-react";
import { EmptyState, InlineActions, KeyHints } from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";
import { GroupActions, SpaceDock } from "./EditorArea";

const THEME: DockviewTheme = {
  ...themeLight,
  className: `${themeLight.className} twigo-dockview twigo-panel`,
  gap: 0,
};

/**
 * The active space's panel: a dockview of its own for sessions opened by
 * URI, such as logs, with tabs and splits, kept per space (ARCHITECTURE
 * 4.1).
 */
export function PanelArea() {
  const { spaces, keys, editors } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  const ref = useRef<HTMLDivElement>(null);
  const panel = space ? spaces.state(space.id).parts.panel : undefined;
  const visible = panel?.visible ?? false;
  const maximized = visible && (panel?.maximized ?? false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const scope = keys.scope(element);
    scope.set("panelFocus", true);
    return () => {
      scope.dispose();
    };
  }, [keys]);

  useEffect(() => {
    keys.set("panelVisible", visible);
    keys.set("panelMaximized", maximized);
  }, [keys, visible, maximized]);

  // The editor area it covers went with the focus, if it held it.
  useEffect(() => {
    if (maximized) editors.keepFocus("panel");
  }, [editors, maximized]);

  return (
    <section
      ref={ref}
      aria-label="Panel"
      className="h-full min-h-0 border-t border-border bg-panel"
    >
      {space && (
        <SpaceDock
          key={space.id}
          space={space.id}
          area="panel"
          theme={THEME}
          actions={PanelGroupActions}
          watermark={EmptyPanel}
        />
      )}
    </section>
  );
}

/**
 * The active input's own actions in each group, and the panel's
 * (maximize, hide) once, in the group at its top right.
 */
function PanelGroupActions(props: IDockviewHeaderActionsProps) {
  const workbench = useWorkbench();
  useChanges(workbench.menus.changes);
  useChanges(workbench.keys.changes);
  const [corner, setCorner] = useState(false);
  const { containerApi, group } = props;

  useEffect(() => {
    const measure = () => {
      // Dockview places each group in a view of its own, so offsets are 0.
      const boxes = containerApi.groups.map((each) =>
        each.element.getBoundingClientRect(),
      );
      const top = Math.min(...boxes.map((box) => box.top));
      const right = Math.max(
        ...boxes.filter((box) => box.top === top).map((box) => box.right),
      );
      const own = group.element.getBoundingClientRect();
      setCorner(own.top === top && own.right === right);
    };
    measure();
    const layout = containerApi.onDidLayoutChange(measure);
    return () => {
      layout.dispose();
    };
  }, [containerApi, group]);

  const lookup = workbench.keys.lookup(null);
  return (
    <div className="flex h-full items-center">
      <GroupActions {...props} />
      {corner && (
        <InlineActions
          className="pr-1.5"
          actions={workbench.actions("panel/title", lookup).flat()}
        />
      )}
    </div>
  );
}

/** What an empty panel shows: how to hide it. */
function EmptyPanel() {
  const { keybindings } = useWorkbench();
  useChanges(keybindings.changes);
  const binding = keybindings.primary("workbench.action.togglePanel");
  return (
    <EmptyState
      icon={PanelBottom}
      title="Nothing open in the panel"
      className="h-full"
    >
      {binding && (
        <KeyHints
          hints={[
            {
              id: "hide",
              keys: keybindings.label(binding.presses),
              label: "Hide the panel",
            },
          ]}
        />
      )}
    </EmptyState>
  );
}

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
  const { spaces, keys } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  const ref = useRef<HTMLDivElement>(null);
  const maximized = space
    ? spaces.state(space.id).parts.panel.maximized
    : false;

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
    keys.set("panelMaximized", maximized);
  }, [keys, maximized]);

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
      const top = Math.min(
        ...containerApi.groups.map((each) => each.element.offsetTop),
      );
      const right = Math.max(
        ...containerApi.groups
          .filter((each) => each.element.offsetTop === top)
          .map((each) => each.element.offsetLeft + each.element.offsetWidth),
      );
      setCorner(
        group.element.offsetTop === top &&
          group.element.offsetLeft + group.element.offsetWidth === right,
      );
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

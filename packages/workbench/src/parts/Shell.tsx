import { useEffect } from "react";
import { Allotment } from "allotment";
import { Toaster } from "@twigo/ui";
import { QuickAccessWidget } from "../quickaccess/QuickAccessWidget";
import { useChanges, useWorkbench } from "../react";
import type { Location } from "../views/registry";
import { ActivityBar } from "./ActivityBar";
import { EditorArea } from "./EditorArea";
import { PartView } from "./PartView";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";

const DEFAULT_SIZE: Readonly<Record<Location, number>> = {
  sidebar: 260,
  panel: 240,
  secondary: 300,
};

/**
 * The parts of ARCHITECTURE 4.1. Sizes and visibility belong to the active
 * space, so the split views remount with it.
 */
export function Shell() {
  const { spaces, keybindings } = useWorkbench();
  useChanges(spaces.changes);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      keybindings.dispatch(event);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [keybindings]);

  const space = spaces.active;
  const parts = space ? spaces.state(space.id).parts : undefined;
  const size = (location: Location) =>
    parts?.[location].size ?? DEFAULT_SIZE[location];
  const remember =
    (locations: readonly (Location | undefined)[]) => (sizes: number[]) => {
      if (!space) return;
      locations.forEach((location, index) => {
        const measured = sizes[index];
        if (location && measured && measured > 0) {
          spaces.setPart(space.id, location, { size: Math.round(measured) });
        }
      });
    };

  return (
    <div className="twigo-workbench flex h-full flex-col">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <Allotment
          key={space?.id}
          className="min-w-0 flex-1"
          proportionalLayout={false}
          onDragEnd={remember(["sidebar", undefined, "secondary"])}
        >
          <Allotment.Pane
            minSize={170}
            preferredSize={size("sidebar")}
            visible={parts?.sidebar.visible ?? false}
          >
            <PartView location="sidebar" />
          </Allotment.Pane>
          <Allotment.Pane minSize={320}>
            <Allotment
              vertical
              proportionalLayout={false}
              onDragEnd={remember([undefined, "panel"])}
            >
              <Allotment.Pane minSize={120}>
                <EditorArea />
              </Allotment.Pane>
              <Allotment.Pane
                minSize={80}
                preferredSize={size("panel")}
                visible={parts?.panel.visible ?? false}
              >
                <PartView location="panel" />
              </Allotment.Pane>
            </Allotment>
          </Allotment.Pane>
          <Allotment.Pane
            minSize={200}
            preferredSize={size("secondary")}
            visible={parts?.secondary.visible ?? false}
          >
            <PartView location="secondary" />
          </Allotment.Pane>
        </Allotment>
      </div>
      <StatusBar />
      <QuickAccessWidget />
      <Toaster />
    </div>
  );
}

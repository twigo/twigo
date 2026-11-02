import { useEffect } from "react";
import { Allotment, LayoutPriority } from "allotment";
import { Toaster } from "@twigo/ui";
import { QuickAccessWidget } from "../quickaccess/QuickAccessWidget";
import { useChanges, useWorkbench } from "../react";
import type { Location } from "../views/registry";
import { ReviewDialog, TrustDialog } from "./credentials/TrustDialog";
import { EditorArea } from "./EditorArea";
import { PanelBoundary, PartCrash } from "./PanelBoundary";
import { PartView } from "./PartView";
import { SpaceRail } from "./SpaceRail";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";

const DEFAULT_SIZE: Readonly<Record<Location, number>> = {
  sidebar: 260,
  panel: 240,
  secondary: 300,
};

/**
 * The parts of ARCHITECTURE 4.1. Visibility belongs to the active space, so
 * the split views remount with it; sizes are the app's.
 */
export function Shell() {
  const { spaces, sizes, keybindings, views } = useWorkbench();
  useChanges(spaces.changes);
  useChanges(sizes.changes);
  useChanges(views.changes);

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
  const shown = (location: Location) =>
    (parts?.[location].visible ?? false) &&
    views.containers(location).length > 0;
  const size = (location: Location) =>
    sizes.get(location) ?? DEFAULT_SIZE[location];
  const remember =
    (locations: readonly (Location | undefined)[]) => (measured: number[]) => {
      locations.forEach((location, index) => {
        const value = measured[index];
        if (location && value && value > 0) {
          sizes.set(location, Math.round(value));
        }
      });
    };

  return (
    <div className="twigo-workbench flex h-full flex-col bg-shell">
      <PanelBoundary
        label="Title bar"
        fallback={(crash) => (
          <div
            data-tauri-drag-region
            className="flex h-9 shrink-0 items-center border-b border-border bg-shell pl-[92px]"
          >
            <PartCrash crash={crash} />
          </div>
        )}
      >
        <TitleBar />
      </PanelBoundary>
      <div className="flex min-h-0 flex-1">
        <PanelBoundary
          label="Space rail"
          fallback={(crash) => (
            <PartCrash
              crash={crash}
              iconOnly
              className="w-12 flex-col border-r border-border bg-shell py-2"
            />
          )}
        >
          <SpaceRail />
        </PanelBoundary>
        <Allotment
          key={space?.id}
          className="min-w-0 flex-1"
          proportionalLayout={false}
          onDragEnd={remember(["sidebar", undefined, "secondary"])}
        >
          <Allotment.Pane
            minSize={170}
            preferredSize={size("sidebar")}
            visible={shown("sidebar")}
          >
            <PartView location="sidebar" />
          </Allotment.Pane>
          <Allotment.Pane minSize={320} priority={LayoutPriority.High}>
            <Allotment
              vertical
              proportionalLayout={false}
              onDragEnd={remember([undefined, "panel"])}
            >
              <Allotment.Pane minSize={120} priority={LayoutPriority.High}>
                <EditorArea />
              </Allotment.Pane>
              <Allotment.Pane
                minSize={80}
                preferredSize={size("panel")}
                visible={shown("panel")}
              >
                <PartView location="panel" />
              </Allotment.Pane>
            </Allotment>
          </Allotment.Pane>
          <Allotment.Pane
            minSize={200}
            preferredSize={size("secondary")}
            visible={shown("secondary")}
          >
            <PartView location="secondary" />
          </Allotment.Pane>
        </Allotment>
      </div>
      <PanelBoundary
        label="Status bar"
        fallback={(crash) => (
          <PartCrash crash={crash} className="h-6 bg-statusbar px-2" />
        )}
      >
        <StatusBar />
      </PanelBoundary>
      <QuickAccessWidget />
      <ReviewDialog />
      <TrustDialog />
      <Toaster />
    </div>
  );
}

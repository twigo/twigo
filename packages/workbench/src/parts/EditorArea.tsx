import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FunctionComponent,
  type MouseEvent,
} from "react";
import {
  DockviewReact,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
} from "dockview-react";
import { FileQuestion, X } from "lucide-react";
import { cn, EmptyState, KeyHints, UnsavedMark } from "@twigo/ui";
import {
  EDITOR_COMPONENT,
  EDITOR_TAB,
  readParams,
  type Area,
  type Editors,
} from "../editors/registry";
import { EditorShownContext, useChanges, useWorkbench } from "../react";
import { PanelBoundary } from "./PanelBoundary";
import { useInertWhile } from "./useInertWhile";

const THEME: DockviewTheme = {
  ...themeLight,
  className: `${themeLight.className} twigo-dockview`,
  gap: 0,
};

/** The active space's editor groups; each space has its own layout (ARCHITECTURE 4.1, 4.2). */
export function EditorArea() {
  const { spaces, keys } = useWorkbench();
  useChanges(spaces.changes);
  const space = spaces.active;
  const ref = useRef<HTMLDivElement>(null);

  useInertWhile(ref, "editor");

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const scope = keys.scope(element);
    scope.set("editorFocus", true);
    return () => {
      scope.dispose();
    };
  }, [keys]);

  return (
    <div ref={ref} className="h-full min-h-0">
      {space && (
        <SpaceDock
          key={space.id}
          space={space.id}
          area="editor"
          theme={THEME}
          actions={GroupActions}
          watermark={Watermark}
        />
      )}
    </div>
  );
}

/**
 * An area's dockview in a space: its saved layout loaded, kept as it
 * changes, and attached to the editor service while it is mounted.
 */
export function SpaceDock({
  space,
  area,
  theme,
  actions,
  watermark,
}: {
  space: string;
  area: Area;
  theme: DockviewTheme;
  actions: FunctionComponent<IDockviewHeaderActionsProps>;
  watermark: FunctionComponent<IWatermarkPanelProps>;
}) {
  const workbench = useWorkbench();
  const [api, setApi] = useState<DockviewApi>();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const key = area === "editor" ? "editors" : "panelEditors";

  // Dockview 8.8 lays out a frame after its ResizeObserver fires
  // (watchElementResize defers to requestAnimationFrame), so the editors
  // trailed a dragged sash; laying out straight from the observer keeps up.
  useEffect(() => {
    if (!api || !host) return;
    let last = "";
    const observer = new ResizeObserver(([entry]) => {
      // A hidden element measures zero, which would collapse the grid: a
      // hidden part is 0 px high, not display:none (allotment 1.20.6).
      if (!entry || !host.offsetParent) return;
      // Rounded and deduplicated: a fractional devicePixelRatio would
      // otherwise lay out against itself.
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width === 0 || height === 0) return;
      const size = `${String(width)}x${String(height)}`;
      if (size === last) return;
      last = size;
      api.layout(width, height);
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
    };
  }, [api, host]);

  useEffect(() => {
    if (!api) return;
    const save = () => {
      workbench.spaces.update(space, (state) => ({
        ...state,
        [key]: api.toJSON(),
      }));
    };
    const changes = api.onDidLayoutChange(save);
    const detach = workbench.editors.attach(api, area, space);
    // Dockview reports layout changes a microtask late (its AsapEvent), so
    // the layout is saved once more as the space goes away, after the
    // listener stops, so nothing the teardown reports can overwrite it.
    return () => {
      changes.dispose();
      save();
      detach();
    };
  }, [api, area, key, space, workbench]);

  const onReady = ({ api: ready }: DockviewReadyEvent) => {
    const saved = workbench.spaces.state(space)[key];
    if (saved) {
      try {
        ready.fromJSON(saved);
      } catch (error) {
        // Dockview 8.8 clears what a failed load added before it rethrows.
        workbench.report(error);
      }
    }
    setApi(ready);
  };

  return (
    <div
      ref={setHost}
      className="h-full"
      onMouseDown={(event) => {
        const { target } = event;
        if (!api || !isPlainPress(event) || !(target instanceof Element)) {
          return;
        }
        const uri = pressedEditor(api, target);
        if (uri !== undefined) focusLater(workbench.editors, uri);
      }}
    >
      <DockviewReact
        theme={theme}
        components={COMPONENTS}
        tabComponents={TABS}
        rightHeaderActionsComponent={actions}
        watermarkComponent={watermark}
        disableAutoResizing
        onReady={onReady}
      />
    </div>
  );
}

/** A left press that no button takes, such as a tab's X. */
function isPlainPress(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !(event.target instanceof Element && event.target.closest("button"))
  );
}

/**
 * The editor a press on a group's tab strip is for: a tab's own, or the
 * group's active one where the strip is empty, as VS Code's title control
 * gives the focus to its group's active editor.
 */
function pressedEditor(api: DockviewApi, target: Element): string | undefined {
  const tab = target.closest<HTMLElement>("[role=tab][data-tab-panel-id]");
  if (tab) {
    return readParams(api.getPanel(tab.dataset.tabPanelId ?? "")?.params)?.uri;
  }
  if (!target.closest(".dv-void-container")) return undefined;
  const group = api.groups.find((each) => each.element.contains(target));
  return readParams(group?.activePanel?.params)?.uri;
}

/** The browser moves the focus after a press's listeners ran, so the editor takes it a task later. */
function focusLater(editors: Editors, uri: string): void {
  setTimeout(() => {
    editors.activate(uri);
  });
}

function EditorPanel({ params: raw, api }: IDockviewPanelProps) {
  const { editors, spaces } = useWorkbench();
  useChanges(editors.changes);
  useChanges(spaces.changes);
  const subscribe = useCallback(
    (changed: () => void) => {
      const listener = api.onDidVisibilityChange(changed);
      return () => {
        listener.dispose();
      };
    },
    [api],
  );
  const visible = useSyncExternalStore(subscribe, () => api.isVisible);
  const params = readParams(raw);
  const provider = params && editors.resolve(params.uri);
  if (!params || !provider) {
    return (
      <EmptyState
        icon={FileQuestion}
        title="Nothing opens this"
        className="h-full"
      >
        <p className="font-mono text-xs">{params?.uri}</p>
      </EmptyState>
    );
  }
  const Component = provider.component;
  const covered = provider.area !== "panel" && !editors.onScreen("editor");
  return (
    <EditorShownContext.Provider value={visible && !covered}>
      <PanelBoundary label={provider.title(new URL(params.uri))}>
        <Component uri={params.uri} />
      </PanelBoundary>
    </EditorShownContext.Provider>
  );
}

export function GroupActions({ activePanel }: IDockviewHeaderActionsProps) {
  const { editors } = useWorkbench();
  const params = readParams(activePanel?.params);
  const provider = params && editors.resolve(params.uri);
  if (!params || !provider?.actions) return null;
  const Actions = provider.actions;
  return (
    <div className="flex h-full items-center pr-1.5">
      <Actions uri={params.uri} />
    </div>
  );
}

function EditorTab({ api, params: raw }: IDockviewPanelHeaderProps) {
  const { editors } = useWorkbench();
  useChanges(editors.changes);
  const params = readParams(raw);
  const provider = params && editors.resolve(params.uri);
  const dirty = params !== undefined && editors.isDirty(params.uri);
  return (
    <div
      className="flex h-full items-center gap-1.5 pr-[3px] pl-2 text-[13px]"
      onDoubleClick={() => {
        if (params) editors.pin(params.uri);
      }}
      onAuxClick={(event) => {
        if (event.button === 1) editors.close(api.id);
      }}
    >
      {params && provider?.icon && (
        <provider.icon
          uri={params.uri}
          className="size-4 shrink-0 text-muted-foreground"
        />
      )}
      <span data-preview={params?.preview ?? false} className="truncate">
        {api.title}
      </span>
      <button
        type="button"
        aria-label={`Close ${api.title ?? ""}`}
        data-dirty={dirty}
        onClick={(event) => {
          event.stopPropagation();
          editors.close(api.id);
        }}
        className={cn(
          "twigo-tab-close -ml-[3px] flex size-5 items-center justify-center rounded",
          "hover:bg-row-hover",
        )}
      >
        {dirty && <UnsavedMark className="twigo-tab-unsaved" />}
        <X className="twigo-tab-x size-3.5" />
      </button>
    </div>
  );
}

/**
 * What an empty editor area shows: the first watermark a feature registered
 * whose `when` holds, such as the cluster's home, else how to open something.
 */
function Watermark() {
  const { views, keys, spaces, keybindings } = useWorkbench();
  useChanges(views.changes);
  useChanges(keys.changes);
  useChanges(keybindings.changes);
  const space = spaces.active;
  const contributed = views.watermark(keys.lookup(null));
  if (space && contributed) {
    const Contributed = contributed.component;
    return <Contributed space={space.id} />;
  }
  const hints = HINTS.flatMap(({ command, label }) => {
    const binding = keybindings.primary(command);
    return binding
      ? [{ id: command, keys: keybindings.label(binding.presses), label }]
      : [];
  });
  return (
    <div className="flex h-full items-center justify-center bg-editor">
      <KeyHints hints={hints} />
    </div>
  );
}

const HINTS: readonly { command: string; label: string }[] = [
  { command: "workbench.action.quickOpen", label: "Go to resource" },
  { command: "workbench.action.showCommands", label: "Show all commands" },
  { command: "workbench.action.quickOpenHelp", label: "Quick access help" },
];

const COMPONENTS = { [EDITOR_COMPONENT]: EditorPanel };
const TABS = { [EDITOR_TAB]: EditorTab };

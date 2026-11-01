import { useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  themeLight,
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react";
import { FileQuestion, X } from "lucide-react";
import { cn, EmptyState, Kbd } from "@twigo/ui";
import { EDITOR_COMPONENT, EDITOR_TAB, readParams } from "../editors/registry";
import { useChanges, useWorkbench } from "../react";
import { PanelBoundary } from "./PanelBoundary";

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
      {space && <SpaceEditors key={space.id} space={space.id} />}
    </div>
  );
}

function SpaceEditors({ space }: { space: string }) {
  const workbench = useWorkbench();
  const [api, setApi] = useState<DockviewApi>();

  useEffect(() => {
    if (!api) return;
    const save = () => {
      workbench.spaces.update(space, (state) => ({
        ...state,
        editors: api.toJSON(),
      }));
    };
    const changes = api.onDidLayoutChange(save);
    const detach = workbench.editors.attach(api);
    // Dockview reports layout changes a microtask late (its AsapEvent), so
    // the layout is saved once more as the space goes away, after the
    // listener stops, so nothing the teardown reports can overwrite it.
    return () => {
      changes.dispose();
      save();
      detach();
    };
  }, [api, space, workbench]);

  const onReady = ({ api: ready }: DockviewReadyEvent) => {
    const saved = workbench.spaces.state(space).editors;
    if (saved) {
      try {
        ready.fromJSON(saved);
      } catch (error) {
        ready.clear();
        workbench.report(error);
      }
    }
    setApi(ready);
  };

  return (
    <DockviewReact
      theme={THEME}
      components={COMPONENTS}
      tabComponents={TABS}
      watermarkComponent={Watermark}
      onReady={onReady}
    />
  );
}

function EditorPanel({ params: raw }: IDockviewPanelProps) {
  const { editors } = useWorkbench();
  useChanges(editors.changes);
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
  return (
    <PanelBoundary label={provider.title(new URL(params.uri))}>
      <Component uri={params.uri} />
    </PanelBoundary>
  );
}

function EditorTab({ api, params: raw }: IDockviewPanelHeaderProps) {
  const { editors } = useWorkbench();
  const params = readParams(raw);
  const provider = params && editors.resolve(params.uri);
  return (
    <div
      className="flex h-full items-center gap-1.5 pr-1 pl-2 text-[13px]"
      onDoubleClick={() => {
        if (params) editors.pin(params.uri);
      }}
      onAuxClick={(event) => {
        if (event.button === 1) api.close();
      }}
    >
      {params && provider?.icon && (
        <provider.icon uri={params.uri} className="size-4 shrink-0" />
      )}
      <span data-preview={params?.preview ?? false} className="truncate">
        {api.title}
      </span>
      <button
        type="button"
        aria-label={`Close ${api.title ?? ""}`}
        onClick={(event) => {
          event.stopPropagation();
          api.close();
        }}
        className={cn(
          "twigo-tab-close flex size-5 items-center justify-center rounded",
          "hover:bg-row-hover",
        )}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** What an empty editor area says: how to open something. */
function Watermark() {
  const { keybindings } = useWorkbench();
  useChanges(keybindings.changes);
  const hint = (command: string, label: string) => {
    const binding = keybindings.primary(command);
    return (
      binding && (
        <p className="flex items-center justify-between gap-6">
          <span>{label}</span>
          <Kbd>{keybindings.label(binding.presses)}</Kbd>
        </p>
      )
    );
  };
  return (
    <div className="flex h-full items-center justify-center bg-editor text-xs text-muted-foreground">
      <div className="flex w-56 flex-col gap-2">
        {hint("workbench.action.quickOpen", "Go to resource")}
        {hint("workbench.action.showCommands", "Show all commands")}
        {hint("workbench.action.quickOpenHelp", "Quick access help")}
      </div>
    </div>
  );
}

const COMPONENTS = { [EDITOR_COMPONENT]: EditorPanel };
const TABS = { [EDITOR_TAB]: EditorTab };

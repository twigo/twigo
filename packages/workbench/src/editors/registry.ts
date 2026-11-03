import type { ComponentType } from "react";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { Changes } from "../changes";
import type { ContextKeys } from "../contextkey/service";

export interface EditorProps {
  readonly uri: string;
}

/** Where editors open: the editor area, or the panel, which holds sessions such as logs (ARCHITECTURE 4.1). */
export type Area = "editor" | "panel";

/**
 * An editor pane for a URI scheme (ARCHITECTURE 4.3). The resolver takes the
 * provider with the highest priority, as VS Code's editor resolver does.
 */
export interface EditorProvider {
  /** Also the `editor.type` context key. */
  readonly id: string;
  readonly scheme: string;
  readonly priority?: number;
  /** Where its editors open; the editor area by default. */
  readonly area?: Area;
  readonly title: (uri: URL) => string;
  /** The tab's icon, which may depend on the URI (the kind of a list). */
  readonly icon?: ComponentType<{ uri: string; className?: string }>;
  readonly component: ComponentType<EditorProps>;
  /** What the editor shows at the right of its group's tab strip while it is the group's active one. */
  readonly actions?: ComponentType<EditorProps>;
}

/** A place in an editor that `@` in quick access goes to, such as a YAML key. */
export interface EditorSymbol {
  readonly label: string;
  readonly detail?: string;
  reveal(): void;
}

/** What a dockview panel of an editor carries; it is also what a layout saves. */
export interface EditorParams {
  readonly uri: string;
  /** A preview tab: italic, and replaced by the next preview in its group. */
  readonly preview: boolean;
}

export const EDITOR_COMPONENT = "editor";
export const EDITOR_TAB = "editor-tab";

/**
 * Opens editors in the active space's editor area and its panel. Each area
 * attaches its dockview while it is mounted; panels are keyed by URI, so
 * opening an open URI focuses it, in whichever area holds it.
 */
export class Editors {
  readonly changes = new Changes();
  readonly #providers = new Set<EditorProvider>();
  readonly #symbols = new Map<string, readonly EditorSymbol[]>();
  readonly #closed = new Set<(uri: string) => void>();
  readonly #apis = new Map<Area, DockviewApi>();
  #active: string | undefined;

  /** `reveal` shows a hidden area before an editor opens in it. */
  constructor(
    private readonly keys: ContextKeys,
    private readonly reveal: (area: Area) => void,
  ) {}

  register(provider: EditorProvider): () => void {
    this.#providers.add(provider);
    this.changes.emit();
    return () => {
      this.#providers.delete(provider);
      this.changes.emit();
    };
  }

  resolve(uri: string): EditorProvider | undefined {
    const scheme = new URL(uri).protocol.slice(0, -1);
    let best: EditorProvider | undefined;
    for (const provider of this.#providers) {
      if (provider.scheme !== scheme) continue;
      if (!best || (provider.priority ?? 0) > (best.priority ?? 0))
        best = provider;
    }
    return best;
  }

  /** The URI of the editor area's active editor; the panel's does not count. */
  get active(): string | undefined {
    return this.#active;
  }

  /** The active editor of an area. */
  activeIn(area: Area): string | undefined {
    const panel = this.#apis.get(area)?.activePanel;
    return panel && paramsOf(panel)?.uri;
  }

  /** The URIs open in an area, in no particular order. */
  openIn(area: Area): string[] {
    return (this.#apis.get(area)?.panels ?? []).flatMap((panel) => {
      const uri = paramsOf(panel)?.uri;
      return uri === undefined ? [] : [uri];
    });
  }

  /**
   * Tells `listener` the URI of each editor that closes. Moving an editor
   * to another group closes none (dockview reports no removal while it
   * moves a panel), and neither does a space giving way to another.
   */
  onClose(listener: (uri: string) => void): () => void {
    this.#closed.add(listener);
    return () => {
      this.#closed.delete(listener);
    };
  }

  /** An area's dockview while it is mounted. */
  attach(api: DockviewApi, area: Area = "editor"): () => void {
    this.#apis.set(area, api);
    const active = api.onDidActivePanelChange(({ panel }) => {
      if (area === "editor") this.#setActive(panel);
      else this.changes.emit();
    });
    const removal = api.onDidRemovePanel((panel) => {
      for (const closed of this.#closed) closed(panel.id);
      if (area === "panel") this.changes.emit();
    });
    const added =
      area === "panel"
        ? api.onDidAddPanel(() => {
            this.changes.emit();
          })
        : undefined;
    if (area === "editor") this.#setActive(api.activePanel);
    return () => {
      active.dispose();
      removal.dispose();
      added?.dispose();
      if (this.#apis.get(area) === api) {
        this.#apis.delete(area);
        if (area === "editor") this.#setActive(undefined);
      }
    };
  }

  /**
   * Opens an editor in its provider's area, unless `area` names another:
   * in the area's active group, or with `side` in a new group to its
   * right. An open URI is focused where it is, since a URI is one panel.
   */
  open(
    uri: string,
    {
      preview = false,
      side = false,
      area,
    }: { preview?: boolean; side?: boolean; area?: Area } = {},
  ): void {
    const provider = this.resolve(uri);
    if (!provider) throw new Error(`no editor opens ${uri}`);
    const open = this.#find(uri);
    if (open) {
      if (!preview) this.pin(uri);
      this.reveal(open.area);
      open.panel.api.setActive();
      return;
    }
    const target = area ?? provider.area ?? "editor";
    const api = this.#apis.get(target);
    if (!api) throw new Error(`no ${target} area is mounted`);
    this.reveal(target);
    const group = api.activeGroup;
    const replaced =
      preview && !side
        ? group?.panels.find((panel) => paramsOf(panel)?.preview)
        : undefined;
    const params: EditorParams = { uri, preview };
    api.addPanel({
      id: uri,
      component: EDITOR_COMPONENT,
      tabComponent: EDITOR_TAB,
      title: provider.title(new URL(uri)),
      params,
      ...(group && {
        position: side
          ? { referenceGroup: group, direction: "right" }
          : {
              referenceGroup: group,
              ...(replaced && { index: group.panels.indexOf(replaced) }),
            },
      }),
    });
    replaced?.api.close();
  }

  /** Turns a preview tab into an ordinary one. */
  pin(uri: string): void {
    const panel = this.#find(uri)?.panel;
    const params = panel && paramsOf(panel);
    if (!panel || !params?.preview) return;
    panel.api.updateParameters({ ...params, preview: false });
  }

  /** An editor publishes its symbols while it shows them. */
  publishSymbols(uri: string, symbols: readonly EditorSymbol[]): () => void {
    this.#symbols.set(uri, symbols);
    return () => {
      if (this.#symbols.get(uri) === symbols) this.#symbols.delete(uri);
    };
  }

  symbols(uri: string): readonly EditorSymbol[] {
    return this.#symbols.get(uri) ?? [];
  }

  title(uri: string): string | undefined {
    return this.#find(uri)?.panel.title;
  }

  /** Renames an open editor's tab, once the editor knows a better title. */
  setTitle(uri: string, title: string): void {
    const panel = this.#find(uri)?.panel;
    if (!panel || panel.title === title) return;
    panel.api.setTitle(title);
    this.changes.emit();
  }

  close(uri: string): void {
    this.#find(uri)?.panel.api.close();
  }

  /** Moves an area's active editor into a new group beside its own. */
  moveActive(side: "right" | "bottom", area: Area = "editor"): void {
    const panel = this.#apis.get(area)?.activePanel;
    if (!panel || panel.group.panels.length < 2) return;
    panel.api.moveTo({ group: panel.group, position: side });
  }

  #find(uri: string): { area: Area; panel: IDockviewPanel } | undefined {
    for (const [area, api] of this.#apis) {
      const panel = api.getPanel(uri);
      if (panel) return { area, panel };
    }
    return undefined;
  }

  #setActive(panel: IDockviewPanel | undefined) {
    const uri = panel && paramsOf(panel)?.uri;
    if (uri === this.#active) return;
    this.#active = uri;
    this.keys.set("editor.open", uri !== undefined);
    this.keys.set(
      "editor.type",
      uri === undefined ? undefined : this.resolve(uri)?.id,
    );
    this.changes.emit();
  }
}

export function paramsOf(panel: IDockviewPanel): EditorParams | undefined {
  return readParams(panel.params);
}

/** Panel params come back from saved layouts too, so they are checked. */
export function readParams(params: unknown): EditorParams | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const { uri, preview } = params as Record<string, unknown>;
  if (typeof uri !== "string") return undefined;
  return { uri, preview: preview === true };
}

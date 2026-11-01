import type { ComponentType } from "react";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { Changes } from "../changes";
import type { ContextKeys } from "../contextkey/service";

export interface EditorProps {
  readonly uri: string;
}

/**
 * An editor pane for a URI scheme (ARCHITECTURE 4.3). The resolver takes the
 * provider with the highest priority, as VS Code's editor resolver does.
 */
export interface EditorProvider {
  /** Also the `editor.type` context key. */
  readonly id: string;
  readonly scheme: string;
  readonly priority?: number;
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
 * Opens editors in the active space's editor area. The area attaches its
 * dockview while it is mounted; panels are keyed by URI, so opening an open
 * URI focuses it.
 */
export class Editors {
  readonly changes = new Changes();
  readonly #providers = new Set<EditorProvider>();
  readonly #symbols = new Map<string, readonly EditorSymbol[]>();
  #api: DockviewApi | undefined;
  #active: string | undefined;

  constructor(private readonly keys: ContextKeys) {}

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

  /** The URI of the active editor. */
  get active(): string | undefined {
    return this.#active;
  }

  attach(api: DockviewApi): () => void {
    this.#api = api;
    const listener = api.onDidActivePanelChange(({ panel }) => {
      this.#setActive(panel);
    });
    this.#setActive(api.activePanel);
    return () => {
      listener.dispose();
      if (this.#api === api) {
        this.#api = undefined;
        this.#setActive(undefined);
      }
    };
  }

  open(uri: string, { preview = false }: { preview?: boolean } = {}): void {
    const api = this.#api;
    if (!api) throw new Error("no editor area is mounted");
    const provider = this.resolve(uri);
    if (!provider) throw new Error(`no editor opens ${uri}`);
    const open = api.getPanel(uri);
    if (open) {
      if (!preview) this.pin(uri);
      open.api.setActive();
      return;
    }
    const group = api.activeGroup;
    const replaced = preview
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
        position: {
          referenceGroup: group,
          ...(replaced && { index: group.panels.indexOf(replaced) }),
        },
      }),
    });
    replaced?.api.close();
  }

  /** Turns a preview tab into an ordinary one. */
  pin(uri: string): void {
    const panel = this.#api?.getPanel(uri);
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

  /** Renames an open editor's tab, once the editor knows a better title. */
  setTitle(uri: string, title: string): void {
    this.#api?.getPanel(uri)?.api.setTitle(title);
  }

  close(uri: string): void {
    this.#api?.getPanel(uri)?.api.close();
  }

  /** Moves the active editor into a new group beside its own. */
  moveActive(side: "right" | "bottom"): void {
    const panel = this.#api?.activePanel;
    if (!panel || panel.group.panels.length < 2) return;
    panel.api.moveTo({ group: panel.group, position: side });
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

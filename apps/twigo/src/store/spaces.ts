import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";
import { useUi } from "@/store/ui";
import { getDomain, type DomainTarget } from "@/shell/domains";

// Spaces: browser-style tabs at the very top of the window. A space is a
// session of technology × target - "NATS · prod-eu", not just "NATS" - the way
// a browser tab is a site, not "the web". Each space is one technology's full
// workbench (its activity bar, its connection bar), remembers where you were
// (last active view), and activating it re-activates its pinned target via the
// domain's registry hook. Domain-free workbench state: a space references a
// domain/target by id only, so the shell owns this store.
export interface Space {
  id: string;
  domainId: string;
  targetId?: string;
  targetLabel?: string;
}

interface SpacesState {
  spaces: Space[];
  activeId: string;
  // Last active view per space, restored when the space re-activates.
  lastView: Record<string, string>;
  setActive: (id: string) => void;
  addSpace: (domainId: string, target?: DomainTarget) => void;
  closeSpace: (id: string) => void;
  // Palette/menu navigation: jump to (or create) a space of this domain.
  activateDomain: (domainId: string) => void;
}

const SEED: Space[] = [
  { id: "space-nats", domainId: "nats" },
  { id: "space-k8s", domainId: "kubernetes" },
];

export const useSpaces = create<SpacesState>()(
  persist(
    (set, get) => ({
      spaces: SEED,
      activeId: "space-nats",
      lastView: {},

      setActive: (id) => {
        const { activeId, lastView, spaces } = get();
        const target = spaces.find((s) => s.id === id);
        if (id === activeId || !target) return;
        const ui = useUi.getState();
        // Park the view we're leaving, then restore the target's parked view
        // (empty = the domain's default, resolved at read time).
        set({
          activeId: id,
          lastView: { ...lastView, [activeId]: ui.activeView },
        });
        ui.setView(get().lastView[id] ?? "");
        // A pinned target re-activates through the domain's hook (NATS context,
        // K8s cluster, …), so the whole workbench follows the tab.
        if (target.targetId) {
          getDomain(target.domainId)?.activateTarget?.(target.targetId);
        }
      },

      addSpace: (domainId, target) => {
        const id = crypto.randomUUID();
        set((s) => ({
          spaces: [
            ...s.spaces,
            { id, domainId, targetId: target?.id, targetLabel: target?.label },
          ],
        }));
        get().setActive(id);
      },

      closeSpace: (id) => {
        const { spaces, activeId } = get();
        if (spaces.length <= 1) return;
        const idx = spaces.findIndex((s) => s.id === id);
        if (idx === -1) return;
        const remaining = spaces.filter((s) => s.id !== id);
        if (id === activeId) {
          const neighbor = remaining[Math.min(idx, remaining.length - 1)];
          if (neighbor) get().setActive(neighbor.id);
        }
        set((s) => {
          const { [id]: _dropped, ...lastView } = s.lastView;
          return { spaces: remaining, lastView };
        });
      },

      activateDomain: (domainId) => {
        const existing = get().spaces.find((s) => s.domainId === domainId);
        if (existing) {
          get().setActive(existing.id);
        } else {
          get().addSpace(domainId);
        }
      },
    }),
    {
      name: "twigo-spaces",
      version: 1,
      storage: createPersistStorage(),
      partialize: (s) => ({
        spaces: s.spaces,
        activeId: s.activeId,
        lastView: s.lastView,
      }),
    },
  ),
);

/** The active space, resolved; undefined only if the store is empty. */
export function useActiveSpace(): Space | undefined {
  return useSpaces((s) => s.spaces.find((x) => x.id === s.activeId));
}

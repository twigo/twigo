import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";
import { useUi } from "@/store/ui";
import { getDomain, type DomainTarget } from "@/shell/domains";

// A space is one workspace tab: a technology plus an optional pinned target
// ("NATS · prod-eu"). It remembers its last active view, and activating it
// re-activates its target via the domain's registry hook. References domains
// and targets by id only, so the shell owns this store.
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
  // Unpin targets of this domain that no longer exist.
  pruneTargets: (domainId: string, targetIds: string[]) => void;
}

const SEED: Space[] = [{ id: "space-nats", domainId: "nats" }];

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
        const { spaces, activeId } = get();
        // Staying put beats jumping: with several spaces of one domain, "go to
        // view" must not yank the user to a sibling tab and its pinned target.
        if (spaces.find((s) => s.id === activeId)?.domainId === domainId)
          return;
        const existing = spaces.find((s) => s.domainId === domainId);
        if (existing) {
          get().setActive(existing.id);
        } else {
          get().addSpace(domainId);
        }
      },

      // Targets are referenced by id (a NATS context name), so one that is gone
      // must be unpinned - activating it would otherwise select a ghost.
      pruneTargets: (domainId, targetIds) =>
        set((s) => {
          const alive = new Set(targetIds);
          if (
            !s.spaces.some(
              (x) =>
                x.domainId === domainId && x.targetId && !alive.has(x.targetId),
            )
          ) {
            return s;
          }
          return {
            spaces: s.spaces.map((x) =>
              x.domainId === domainId && x.targetId && !alive.has(x.targetId)
                ? { id: x.id, domainId: x.domainId }
                : x,
            ),
          };
        }),
    }),
    {
      name: "twigo-spaces",
      // v2 drops v1 state that could reference the removed mock K8s domain
      // (pre-prod: no migrations, discard on version mismatch).
      version: 2,
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

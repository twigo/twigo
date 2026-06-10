import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DockviewApi } from "dockview-react";
import { createPersistStorage } from "@/lib/persist-storage";

type SerializedLayout = ReturnType<DockviewApi["toJSON"]>;

// The persisted workspace manifest: enough to rebuild the previous session
// (editor geometry + which connections/watches were open) but no live state.
// Editor layout is kept per connection so each context has its own tab set;
// the Dockview blob already serializes each panel's params (type/connId/
// subject), so no separate tab list is needed.
interface WorkspaceState {
  layouts: Record<string, SerializedLayout>;
  lastConnected: string[];
  watching: Record<string, string>;
  activeContext: string | null;
  setLayout: (connId: string, layout: SerializedLayout) => void;
  setConnected: (name: string, connected: boolean) => void;
  setWatching: (conn: string, pattern: string | null) => void;
  setActiveContext: (name: string | null) => void;
  // Drop persisted state for connections that no longer exist (renamed/deleted
  // in the nats CLI) so it can't orphan or trigger ghost reconnects.
  prune: (names: string[]) => void;
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      layouts: {},
      lastConnected: [],
      watching: {},
      activeContext: null,

      setLayout: (connId, layout) =>
        set((s) => ({ layouts: { ...s.layouts, [connId]: layout } })),

      setActiveContext: (activeContext) => set({ activeContext }),

      prune: (names) =>
        set((s) => {
          const keep = new Set(names);
          const pick = <T>(obj: Record<string, T>) =>
            Object.fromEntries(
              // "" is the no-connection layout bucket; always keep it.
              Object.entries(obj).filter(([k]) => k === "" || keep.has(k)),
            );
          return {
            layouts: pick(s.layouts),
            watching: Object.fromEntries(
              Object.entries(s.watching).filter(([k]) => keep.has(k)),
            ),
            lastConnected: s.lastConnected.filter((n) => keep.has(n)),
            activeContext:
              s.activeContext && keep.has(s.activeContext)
                ? s.activeContext
                : null,
          };
        }),

      setConnected: (name, connected) =>
        set((s) => ({
          lastConnected: connected
            ? s.lastConnected.includes(name)
              ? s.lastConnected
              : [...s.lastConnected, name]
            : s.lastConnected.filter((n) => n !== name),
        })),

      setWatching: (conn, pattern) =>
        set((s) => ({
          watching:
            pattern === null
              ? Object.fromEntries(
                  Object.entries(s.watching).filter(([k]) => k !== conn),
                )
              : { ...s.watching, [conn]: pattern },
        })),
    }),
    {
      name: "twigo-workspace",
      version: 2,
      storage: createPersistStorage(),
      partialize: (s) => ({
        layouts: s.layouts,
        lastConnected: s.lastConnected,
        watching: s.watching,
        activeContext: s.activeContext,
      }),
    },
  ),
);

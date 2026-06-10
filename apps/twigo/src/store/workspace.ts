import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DockviewApi } from "dockview-react";
import { createPersistStorage } from "@/lib/persist-storage";

type SerializedLayout = ReturnType<DockviewApi["toJSON"]>;

// The persisted workspace manifest: enough to rebuild the previous session
// (editor geometry + which connections/watches were open) but no live state.
// The Dockview layout already serializes each panel's params (type/connId/
// subject), so no separate tab list is needed.
interface WorkspaceState {
  layout: SerializedLayout | null;
  lastConnected: string[];
  watching: Record<string, string>;
  activeContext: string | null;
  setLayout: (layout: SerializedLayout) => void;
  setConnected: (name: string, connected: boolean) => void;
  setWatching: (conn: string, pattern: string | null) => void;
  setActiveContext: (name: string | null) => void;
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      layout: null,
      lastConnected: [],
      watching: {},
      activeContext: null,

      setLayout: (layout) => set({ layout }),

      setActiveContext: (activeContext) => set({ activeContext }),

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
      version: 1,
      storage: createPersistStorage(),
      partialize: (s) => ({
        layout: s.layout,
        lastConnected: s.lastConnected,
        watching: s.watching,
        activeContext: s.activeContext,
      }),
    },
  ),
);

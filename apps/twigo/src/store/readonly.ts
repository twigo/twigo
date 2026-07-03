import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";

// A per-connection read-only guardrail (fat-finger protection for prod): when a
// connection is locked, every write command is blocked before it reaches the
// server. Persisted so the lock survives restarts. Reads/subscribe/browse stay
// allowed - see api.ts assertWritable for what counts as a write.
interface ReadOnlyState {
  byConn: Record<string, boolean>;
  isReadOnly: (conn: string) => boolean;
  setReadOnly: (conn: string, value: boolean) => void;
  toggle: (conn: string) => void;
  // Locks are keyed by context name; drop entries for contexts that no longer
  // exist so a later context reusing the name doesn't inherit a stale lock.
  prune: (names: string[]) => void;
}

export const useReadOnly = create<ReadOnlyState>()(
  persist(
    (set, get) => ({
      byConn: {},
      isReadOnly: (conn) => get().byConn[conn] ?? false,
      setReadOnly: (conn, value) =>
        set((s) => {
          if (!value) {
            const { [conn]: _drop, ...byConn } = s.byConn;
            return { byConn };
          }
          return { byConn: { ...s.byConn, [conn]: true } };
        }),
      toggle: (conn) => get().setReadOnly(conn, !get().isReadOnly(conn)),
      prune: (names) =>
        set((s) => {
          const keep = new Set(names);
          return {
            byConn: Object.fromEntries(
              Object.entries(s.byConn).filter(([k]) => keep.has(k)),
            ),
          };
        }),
    }),
    {
      name: "twigo-readonly",
      version: 1,
      storage: createPersistStorage(),
      partialize: (s) => ({ byConn: s.byConn }),
    },
  ),
);

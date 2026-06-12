import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";

// Recently-run command ids, most-recent-first, for the palette's "Recently used"
// group on an empty query. Persisted so the list survives restarts.
const CAP = 8;

interface CommandHistoryState {
  recent: string[];
  record: (id: string) => void;
}

export const useCommandHistory = create<CommandHistoryState>()(
  persist(
    (set) => ({
      recent: [],
      record: (id) =>
        set((s) => ({
          recent: [id, ...s.recent.filter((x) => x !== id)].slice(0, CAP),
        })),
    }),
    {
      name: "twigo-command-history",
      version: 1,
      storage: createPersistStorage(),
      partialize: (s) => ({ recent: s.recent }),
    },
  ),
);

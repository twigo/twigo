import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";

// Persisted because the quiet check runs once per launch: a per-session counter
// could never reach a threshold.
interface UpdateCheckState {
  failures: number;
  lastError: string | null;
  recordSuccess: () => void;
  recordFailure: (message: string) => number;
  snooze: () => void;
}

export const useUpdateCheck = create<UpdateCheckState>()(
  persist(
    (set, get) => ({
      failures: 0,
      lastError: null,
      recordSuccess: () => set({ failures: 0, lastError: null }),
      recordFailure: (message) => {
        const failures = get().failures + 1;
        set({ failures, lastError: message });
        return failures;
      },
      snooze: () => set({ failures: 0 }),
    }),
    {
      name: "twigo-update-check",
      storage: createPersistStorage(),
    },
  ),
);

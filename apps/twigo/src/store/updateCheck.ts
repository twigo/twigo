import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";

interface UpdateCheckState {
  // Counted across launches, not within a session: the quiet check runs once
  // per start, so a per-session counter could never reach a threshold.
  failures: number;
  lastError: string | null;
  recordSuccess: () => void;
  /** Returns the new consecutive-failure count. */
  recordFailure: (message: string) => number;
  /** Zero the counter after warning, so the warning repeats every N failures. */
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

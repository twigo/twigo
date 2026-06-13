import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";

interface SettingsState {
  contextDir: string | null;
  setContextDir: (dir: string | null) => void;
  // Adds the public demo.nats.io server to the context list (zero-setup trial).
  includeDemo: boolean;
  setIncludeDemo: (include: boolean) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      contextDir: null,
      setContextDir: (contextDir) =>
        set({ contextDir: contextDir?.trim() ? contextDir.trim() : null }),
      includeDemo: false,
      setIncludeDemo: (includeDemo) => set({ includeDemo }),
    }),
    {
      name: "twigo-settings",
      version: 1,
      storage: createPersistStorage(),
      partialize: (s) => ({
        contextDir: s.contextDir,
        includeDemo: s.includeDemo,
      }),
    },
  ),
);

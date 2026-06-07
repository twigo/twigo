import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  contextDir: string | null;
  setContextDir: (dir: string | null) => void;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      contextDir: null,
      setContextDir: (contextDir) =>
        set({ contextDir: contextDir?.trim() ? contextDir.trim() : null }),
    }),
    {
      name: "twigo-settings",
      version: 1,
      migrate: (persisted) => persisted as SettingsState,
      partialize: (s) => ({ contextDir: s.contextDir }),
    },
  ),
);

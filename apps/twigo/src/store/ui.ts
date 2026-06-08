import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";

export type Theme = "light" | "dark";

export type View = "subjects" | "jetstream" | "kv" | "objectstore" | "monitor";

interface UiState {
  theme: Theme;
  activeView: View;
  sidebarOpen: boolean;
  detailOpen: boolean;
  shellSizes: number[];
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  setView: (v: View) => void;
  toggleSidebar: () => void;
  toggleDetail: () => void;
  setShellSizes: (sizes: number[]) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: "dark",
      activeView: "subjects",
      sidebarOpen: true,
      detailOpen: true,
      shellSizes: [],
      toggleTheme: () =>
        set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
      setTheme: (theme) => set({ theme }),
      setView: (activeView) => set({ activeView }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleDetail: () => set((s) => ({ detailOpen: !s.detailOpen })),
      setShellSizes: (shellSizes) => set({ shellSizes }),
    }),
    {
      name: "twigo-ui",
      version: 1,
      storage: createPersistStorage(),
      partialize: (s) => ({
        theme: s.theme,
        activeView: s.activeView,
        sidebarOpen: s.sidebarOpen,
        detailOpen: s.detailOpen,
        shellSizes: s.shellSizes,
      }),
    },
  ),
);

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
}

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark";

export type View = "subjects" | "jetstream" | "kv" | "objectstore" | "monitor";

interface UiState {
  theme: Theme;
  activeView: View;
  sidebarOpen: boolean;
  detailOpen: boolean;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  setView: (v: View) => void;
  toggleSidebar: () => void;
  toggleDetail: () => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: "dark",
      activeView: "subjects",
      sidebarOpen: true,
      detailOpen: true,
      toggleTheme: () =>
        set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
      setTheme: (theme) => set({ theme }),
      setView: (activeView) => set({ activeView }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleDetail: () => set((s) => ({ detailOpen: !s.detailOpen })),
    }),
    { name: "twigo-ui" },
  ),
);

/** Apply the theme class to <html>. Call once on mount + on theme change. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
}

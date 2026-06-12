import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";

// The user's choice; "system" follows the OS appearance.
export type Theme = "light" | "dark" | "system";
// What's actually painted — never "system".
export type ResolvedTheme = "light" | "dark";

function systemPrefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

// A registered view's id (e.g. "subjects"). The shell treats it as an opaque
// string — view ids are owned by domain modules, not the UI store.
export type View = string;

interface UiState {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  activeView: View;
  sidebarOpen: boolean;
  detailOpen: boolean;
  shellSizes: number[];
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
  syncResolvedTheme: () => void;
  setView: (v: View) => void;
  toggleSidebar: () => void;
  toggleDetail: () => void;
  setShellSizes: (sizes: number[]) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      theme: "dark",
      resolvedTheme: "dark",
      activeView: "subjects",
      sidebarOpen: true,
      detailOpen: true,
      shellSizes: [],
      // Quick toggle stays binary: flip whatever is currently shown to its
      // opposite, dropping the "system" link in favor of that explicit choice.
      toggleTheme: () =>
        set((s) => {
          const next: ResolvedTheme =
            s.resolvedTheme === "dark" ? "light" : "dark";
          return { theme: next, resolvedTheme: next };
        }),
      setTheme: (theme) => set({ theme, resolvedTheme: resolveTheme(theme) }),
      // Recompute the painted theme from the current choice — used after
      // hydration and when the OS appearance changes while on "system".
      syncResolvedTheme: () =>
        set((s) => ({ resolvedTheme: resolveTheme(s.theme) })),
      setView: (activeView) => set({ activeView }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      toggleDetail: () => set((s) => ({ detailOpen: !s.detailOpen })),
      setShellSizes: (shellSizes) => set({ shellSizes }),
    }),
    {
      name: "twigo-ui",
      version: 1,
      // resolvedTheme is derived, never persisted — recomputed on startup.
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

export function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
}

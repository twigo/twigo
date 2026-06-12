import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";

// Per-connection HTTP monitoring URL (:8222), set in-app and persisted in
// Twigo's own store - keyed by context name, kept out of the nats context file.
interface MonitorConfigState {
  urls: Record<string, string>;
  setUrl: (conn: string, url: string | null) => void;
}

export const useMonitorConfig = create<MonitorConfigState>()(
  persist(
    (set) => ({
      urls: {},
      setUrl: (conn, url) =>
        set((s) => {
          const trimmed = url?.trim();
          if (!trimmed) {
            const { [conn]: _drop, ...urls } = s.urls;
            return { urls };
          }
          return { urls: { ...s.urls, [conn]: trimmed } };
        }),
    }),
    {
      name: "twigo-monitor-config",
      version: 1,
      storage: createPersistStorage(),
      partialize: (s) => ({ urls: s.urls }),
    },
  ),
);

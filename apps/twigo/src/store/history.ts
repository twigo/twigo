import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createPersistStorage } from "@/lib/persist-storage";

const CAP = 200;
// Larger payloads are recorded without their body so the history file stays small.
const MAX_STORED_PAYLOAD = 256 * 1024;

export interface SentEntry {
  id: number;
  at: number;
  connId: string;
  kind: "publish" | "request";
  subject: string;
  payloadB64: string;
  truncated: boolean;
  headers: [string, string][];
}

interface HistoryState {
  entries: SentEntry[];
  nextId: number;
  record: (e: Omit<SentEntry, "id" | "at" | "truncated">) => void;
  clear: (connId: string) => void;
}

export const useHistory = create<HistoryState>()(
  persist(
    (set) => ({
      entries: [],
      nextId: 1,
      record: (e) =>
        set((s) => {
          const truncated = e.payloadB64.length > MAX_STORED_PAYLOAD;
          const entry: SentEntry = {
            ...e,
            payloadB64: truncated ? "" : e.payloadB64,
            truncated,
            id: s.nextId,
            at: Date.now(),
          };
          return {
            nextId: s.nextId + 1,
            entries: [entry, ...s.entries].slice(0, CAP),
          };
        }),
      clear: (connId) =>
        set((s) => ({
          entries: s.entries.filter((e) => e.connId !== connId),
        })),
    }),
    {
      name: "twigo-history",
      version: 1,
      storage: createPersistStorage(),
      partialize: (s) => ({ entries: s.entries, nextId: s.nextId }),
    },
  ),
);

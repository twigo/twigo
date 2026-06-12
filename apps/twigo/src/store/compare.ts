import { create } from "zustand";
import type { StreamMessage } from "@twigo/utils";

// A pinned message to diff others against. Holds a snapshot (not just an id) so
// the comparison survives the pinned message scrolling out of the ring buffer.
// Ephemeral — cleared on its own, not persisted.
interface CompareState {
  pinned: StreamMessage | null;
  pin: (msg: StreamMessage) => void;
  clear: () => void;
}

export const useCompare = create<CompareState>((set) => ({
  pinned: null,
  pin: (msg) => set({ pinned: msg }),
  clear: () => set({ pinned: null }),
}));

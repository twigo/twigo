import { create } from "zustand";

interface HelpState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useHelp = create<HelpState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));

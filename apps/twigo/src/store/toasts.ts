import { create } from "zustand";

export type ToastKind = "error" | "warning" | "info";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
}

const TTL_MS = 6000;
let seq = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message) => {
    seq += 1;
    const id = seq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, TTL_MS);
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

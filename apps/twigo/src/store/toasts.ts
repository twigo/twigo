import { create } from "zustand";

export type ToastKind = "error" | "warning" | "info" | "success";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

interface ToastState {
  toasts: Toast[];
  push: (kind: ToastKind, message: string, action?: ToastAction) => void;
  dismiss: (id: number) => void;
}

const TTL_MS = 6000;
// Actionable toasts (e.g. Undo) live longer so there's time to act.
const TTL_ACTION_MS = 10000;
let seq = 0;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message, action) => {
    seq += 1;
    const id = seq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message, action }] }));
    setTimeout(
      () => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      },
      action ? TTL_ACTION_MS : TTL_MS,
    );
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

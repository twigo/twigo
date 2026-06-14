import { create } from "zustand";

export type ToastKind = "error" | "warning" | "info" | "success";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  // Repeats sharing a key coalesce into one toast with an xN badge instead of
  // stacking - the fix for reconnect/error bursts.
  key?: string;
  // Override the per-kind lifetime; Infinity keeps the toast until dismissed.
  ttl?: number;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  key: string;
  count: number;
  ttl: number;
  // While true the toast plays its exit transition before it is removed.
  leaving: boolean;
}

interface ToastState {
  toasts: Toast[];
  queue: Toast[];
  push: (kind: ToastKind, message: string, opts?: ToastOptions) => number;
  dismiss: (id: number) => void;
}

// At most this many toasts are visible at once; the rest wait in the queue and
// are promoted (timer started only then) as slots free up.
const MAX_VISIBLE = 3;
// Must match the exit animation duration in index.css ([data-twigo-toast]).
const EXIT_MS = 150;

// Hold the slot for the exit animation, but not under reduced-motion (the
// global CSS rule collapses the animation, so the toast is already gone).
function exitDelay(): number {
  const reduced =
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduced ? 0 : EXIT_MS;
}
// Calm is not ephemeral: info/success fade, warnings/errors wait to be read.
const TTL: Record<ToastKind, number> = {
  success: 4000,
  info: 6000,
  warning: Infinity,
  error: Infinity,
};
// An actionable toast lives long enough to act on, but never shorter than its
// kind already would (an actionable error stays sticky).
const TTL_ACTION_FLOOR = 10000;

let seq = 0;
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();
const exitTimers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(
  map: Map<number, ReturnType<typeof setTimeout>>,
  id: number,
) {
  const t = map.get(id);
  if (t) {
    clearTimeout(t);
    map.delete(id);
  }
}

function armDismiss(id: number, ttl: number) {
  clearTimer(dismissTimers, id);
  if (!Number.isFinite(ttl)) return;
  dismissTimers.set(
    id,
    setTimeout(() => {
      dismissTimers.delete(id);
      useToasts.getState().dismiss(id);
    }, ttl),
  );
}

export const useToasts = create<ToastState>((set, get) => {
  // Move the next queued toast into a freed slot and start its timer (queued
  // toasts must not age while they wait).
  function promote() {
    const { toasts, queue } = get();
    const next = queue[0];
    if (!next || toasts.length >= MAX_VISIBLE) return;
    set({ toasts: [...toasts, next], queue: queue.slice(1) });
    armDismiss(next.id, next.ttl);
  }

  return {
    toasts: [],
    queue: [],

    push: (kind, message, opts) => {
      const key = opts?.key ?? `${kind}|${message}`;

      // Coalesce into a live toast (visible or queued) that shares the key.
      const { toasts, queue } = get();
      const existing =
        toasts.find((t) => t.key === key) ?? queue.find((t) => t.key === key);
      // A true repeat (same kind + message) bumps the badge and keeps the
      // existing action when the caller omits one; a lifecycle change (e.g. a
      // "reconnecting" warning flipping to a "reconnected" success) resets both.
      const repeat =
        !!existing && existing.message === message && existing.kind === kind;
      const action = repeat ? (opts?.action ?? existing.action) : opts?.action;
      const ttl =
        opts?.ttl ??
        (action ? Math.max(TTL[kind], TTL_ACTION_FLOOR) : TTL[kind]);

      if (existing) {
        const patched: Toast = {
          ...existing,
          kind,
          message,
          action,
          ttl,
          leaving: false,
          count: repeat ? existing.count + 1 : 1,
        };
        clearTimer(exitTimers, existing.id);
        set((s) => ({
          toasts: s.toasts.map((t) => (t.id === existing.id ? patched : t)),
          queue: s.queue.map((t) => (t.id === existing.id ? patched : t)),
        }));
        // Re-arm only if it is actually on screen; queued toasts arm on promote.
        if (get().toasts.some((t) => t.id === existing.id)) {
          armDismiss(existing.id, ttl);
        }
        return existing.id;
      }

      seq += 1;
      const id = seq;
      const toast: Toast = {
        id,
        kind,
        message,
        action,
        key,
        count: 1,
        ttl,
        leaving: false,
      };
      if (get().toasts.length < MAX_VISIBLE) {
        set((s) => ({ toasts: [...s.toasts, toast] }));
        armDismiss(id, ttl);
      } else {
        set((s) => ({ queue: [...s.queue, toast] }));
      }
      return id;
    },

    dismiss: (id) => {
      clearTimer(dismissTimers, id);
      if (get().queue.some((t) => t.id === id)) {
        set((s) => ({ queue: s.queue.filter((t) => t.id !== id) }));
        return;
      }
      const cur = get().toasts.find((t) => t.id === id);
      if (!cur || cur.leaving) return;
      // Phase 1: mark leaving so the exit animation plays.
      set((s) => ({
        toasts: s.toasts.map((t) =>
          t.id === id ? { ...t, leaving: true } : t,
        ),
      }));
      // Phase 2: drop it once the animation has run, then fill the slot.
      exitTimers.set(
        id,
        setTimeout(() => {
          exitTimers.delete(id);
          set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
          promote();
        }, exitDelay()),
      );
    },
  };
});

import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  CountdownToast,
  Toast,
  type CountdownToastProps,
  type ToastAction,
  type Tone,
} from "./toast";

/** Info and success fade; warnings and errors wait to be read. */
const DURATION: Readonly<Record<Tone, number>> = {
  success: 4000,
  info: 6000,
  warning: Infinity,
  error: Infinity,
};

export interface NotifyOptions {
  /** One, beside Dismiss. */
  action?: ToastAction;
  /** A repeat with the same key replaces the toast instead of stacking. */
  key?: string;
}

const show =
  (tone: Tone) =>
  (message: ReactNode, { action, key }: NotifyOptions = {}) =>
    toast.custom(
      (id) => <Toast id={id} tone={tone} message={message} action={action} />,
      { duration: DURATION[tone], ...(key !== undefined && { id: key }) },
    );

/** A countdown's toast, which stays until its owner dismisses it. */
function countdown(props: CountdownToastProps): { dismiss: () => void } {
  const id = toast.custom(() => <CountdownToast {...props} />, {
    duration: Infinity,
  });
  return {
    dismiss: () => {
      toast.dismiss(id);
    },
  };
}

/**
 * A toast from anywhere: plain functions, no provider to be under. The app's
 * `<Toaster/>` shows them; sonner positions, stacks and times them, as in
 * Segla's front.
 */
export const notify = {
  success: show("success"),
  error: show("error"),
  warning: show("warning"),
  info: show("info"),
  countdown,
};

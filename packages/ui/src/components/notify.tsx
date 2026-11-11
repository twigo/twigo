import type { ReactNode } from "react";
import { toast } from "sonner";
import {
  ChoiceToast,
  CountdownToast,
  Toast,
  type ChoiceToastProps,
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

/**
 * A countdown's toast, which stays until its owner dismisses it: it cannot
 * be swiped away, and anything else that dismisses it cancels it, so it
 * never runs out unseen.
 */
function countdown(props: CountdownToastProps): { dismiss: () => void } {
  const id = toast.custom(() => <CountdownToast {...props} />, {
    duration: Infinity,
    dismissible: false,
    onDismiss: props.action.run,
  });
  return {
    dismiss: () => {
      toast.dismiss(id);
    },
  };
}

/**
 * Something that waits for an answer, until its owner dismisses it: it
 * cannot be swiped away, and a call with the same key shows the new words in
 * its place.
 */
function choice(props: ChoiceToastProps, key: string): { dismiss: () => void } {
  const id = toast.custom(() => <ChoiceToast {...props} />, {
    id: key,
    duration: Infinity,
    dismissible: false,
  });
  return {
    dismiss: () => {
      toast.dismiss(id);
    },
  };
}

/**
 * What ran, with its undo for as long as it lasts: the toast goes when the
 * undo ends, or when its owner says it was taken, as a refused or cancelled
 * undo still lasts; dismissing it leaves the undo to ⌘Z.
 */
function undoable(props: CountdownToastProps): { dismiss: () => void } {
  const id = toast.custom(() => <CountdownToast {...props} />, {
    duration: Math.max(0, props.until - Date.now()),
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
  undoable,
  choice,
};

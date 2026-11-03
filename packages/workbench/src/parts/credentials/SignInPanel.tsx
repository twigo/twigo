import type { ReactNode } from "react";
import { X } from "lucide-react";
import { IconButton } from "@twigo/ui";
import { useWorkbench } from "../../react";

/**
 * The sign-in panel, above its entry and moving with it. Not a popover: a
 * popover's dismissable layer takes Escape for itself, and the code must
 * stay in view while the person works elsewhere, in Twigo or a browser. It
 * takes no focus, and closes from its close button, the entry, or a run
 * that succeeds; a failure seen in the space opens it again.
 */
export function SignInPanel({ children }: { children: ReactNode }) {
  const { credentials } = useWorkbench();
  return (
    <section
      aria-label="Sign in"
      className="absolute bottom-full left-0 z-50 mb-1 w-96 rounded-md border border-border bg-popover/90 p-3 text-popover-foreground shadow-lg backdrop-blur-xl"
    >
      <IconButton
        icon={X}
        label="Hide"
        className="absolute top-2 right-2"
        onClick={() => {
          credentials.setPanelOpen(false);
        }}
      />
      {children}
    </section>
  );
}

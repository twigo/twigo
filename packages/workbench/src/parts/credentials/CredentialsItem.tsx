import { KeyRound, Loader2, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { useChanges, useWorkbench } from "../../react";
import { SignInBody } from "./SignIn";
import { useSignIn } from "./useSignIn";

const ITEM =
  "flex h-6 items-center gap-1.5 px-1.5 hover:bg-statusbar-foreground/10";

/**
 * The active context's credentials in the status bar, when they need the
 * person: a plugin to trust, a run under way, or one that failed. The
 * sign-in panel opens above it.
 */
export function CredentialsItem() {
  const { credentials } = useWorkbench();
  useChanges(credentials.changes);
  const { auth } = credentials;
  const run = useSignIn();

  if (auth.state === "invalid") {
    return (
      <span className={ITEM} title={auth.message} role="status">
        <TriangleAlert aria-hidden className="size-3.5" />
        Kubeconfig entry unusable
      </span>
    );
  }
  if (auth.state === "untrusted") {
    return (
      <button
        type="button"
        className={ITEM}
        onClick={() => {
          credentials.setTrustOpen(true);
        }}
      >
        <ShieldAlert aria-hidden className="size-3.5" />
        Trust {base(auth.plugin.command)}?
      </button>
    );
  }
  if (auth.state === "plugin" && auth.status.state === "waiting") {
    return (
      <span className={ITEM} role="status">
        <KeyRound aria-hidden className="size-3.5" />
        Sign-in waits for this window
      </span>
    );
  }
  if (!run) return null;

  const failed = run.status.state === "failed";
  const label = failed
    ? run.plugin.signsIn
      ? "Sign-in failed"
      : "No credentials"
    : run.plugin.signsIn
      ? "Signing in…"
      : `Running ${base(run.plugin.command)}…`;
  return (
    <span className="relative">
      <button
        type="button"
        className={ITEM}
        aria-expanded={credentials.panelOpen}
        onClick={() => {
          credentials.setPanelOpen(!credentials.panelOpen);
        }}
      >
        {failed ? (
          <TriangleAlert aria-hidden className="size-3.5" />
        ) : (
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
        )}
        {label}
      </button>
      {credentials.panelOpen && (
        <Panel>
          <SignInBody {...run} />
        </Panel>
      )}
    </span>
  );
}

/**
 * The sign-in panel, above its item and moving with it. Not a popover: a
 * popover's dismissable layer takes Escape for itself, and the code must
 * stay in view while the person works elsewhere, in Twigo or a browser. It
 * takes no focus, and closes from its close button, the item, or a run
 * that succeeds; a failure seen in the space opens it again.
 */
function Panel({ children }: { children: React.ReactNode }) {
  const { credentials } = useWorkbench();
  return (
    <section
      aria-label="Sign in"
      className="absolute bottom-full left-0 z-50 mb-1 w-96 rounded-md border border-border bg-popover/90 p-3 text-popover-foreground shadow-lg backdrop-blur-xl"
    >
      <button
        type="button"
        aria-label="Hide"
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-accent"
        onClick={() => {
          credentials.setPanelOpen(false);
        }}
      >
        <X className="size-3.5" />
      </button>
      {children}
    </section>
  );
}

function base(command: string): string {
  return command.split("/").pop() ?? command;
}

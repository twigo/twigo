import { KeyRound, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@twigo/ui";
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
        Trust {auth.plugin.command}?
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
  const trigger = (
    <button
      type="button"
      className={ITEM}
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
  );
  return (
    <Popover
      open={credentials.panelOpen}
      onOpenChange={(open) => {
        credentials.setPanelOpen(open);
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        className="w-96 p-3"
        // It opens by itself, so it leaves the focus where the person is.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        // A run under way keeps its panel: the code must stay in view while
        // the person types it elsewhere, Escape included.
        onInteractOutside={(event) => {
          if (!failed) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (!failed) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
      >
        <SignInBody {...run} />
      </PopoverContent>
    </Popover>
  );
}

function base(command: string): string {
  return command.split("/").pop() ?? command;
}

import { KeyRound, Loader2, ShieldAlert, TriangleAlert } from "lucide-react";
import { useChanges, useWorkbench } from "../../react";
import type { StatusEntry } from "../../views/registry";
import { SignInPanel } from "./SignInPanel";
import { SignInBody } from "./SignIn";
import { useSignIn } from "./useSignIn";

/**
 * The active context's credentials in the status bar, when they need the
 * person: a plugin to trust, a run under way, or one that failed. The
 * sign-in panel opens above it.
 */
export function useCredentialEntries(): readonly StatusEntry[] {
  const { credentials } = useWorkbench();
  useChanges(credentials.changes);
  const { auth } = credentials;
  const run = useSignIn();

  if (auth.state === "invalid") {
    return [
      {
        id: "credentials",
        text: "Kubeconfig entry unusable",
        icon: TriangleAlert,
        tooltip: auth.message,
      },
    ];
  }
  if (auth.state === "untrusted") {
    return [
      {
        id: "credentials",
        text: `Trust ${base(auth.plugin.command)}?`,
        icon: ShieldAlert,
        run: () => {
          credentials.setTrustOpen(true);
        },
      },
    ];
  }
  if (auth.state === "plugin" && auth.status.state === "waiting") {
    return [
      {
        id: "credentials",
        text: "Sign-in waits for this window",
        icon: KeyRound,
      },
    ];
  }
  if (!run) return [];

  const failed = run.status.state === "failed";
  return [
    {
      id: "credentials",
      text: failed
        ? run.plugin.signsIn
          ? "Sign-in failed"
          : "No credentials"
        : run.plugin.signsIn
          ? "Signing in…"
          : `Running ${base(run.plugin.command)}…`,
      icon: failed ? TriangleAlert : Loader2,
      spin: !failed,
      expanded: credentials.panelOpen,
      run: () => {
        credentials.setPanelOpen(!credentials.panelOpen);
      },
      ...(credentials.panelOpen && {
        panel: (
          <SignInPanel>
            <SignInBody {...run} />
          </SignInPanel>
        ),
      }),
    },
  ];
}

function base(command: string): string {
  return command.split("/").pop() ?? command;
}

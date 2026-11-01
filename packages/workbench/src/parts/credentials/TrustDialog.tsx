import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { ExecPlugin, ReviewedPlugin } from "@twigo/protocol";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@twigo/ui";
import { useChanges, useWorkbench } from "../../react";

/**
 * Asks before the active context's plugin first runs, or runs changed
 * (ARCHITECTURE 6.2): a plugin is a command chosen by whoever wrote the
 * kubeconfig.
 */
export function TrustDialog() {
  const { credentials } = useWorkbench();
  useChanges(credentials.changes);
  const { auth, context } = credentials;
  if (auth.state !== "untrusted" || context === undefined) return null;
  return (
    <Dialog
      open={credentials.trustOpen}
      onOpenChange={(open) => {
        credentials.setTrustOpen(open);
      }}
    >
      <DialogContent className="max-w-lg p-4">
        <div className="flex items-start gap-2.5">
          <ShieldAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-warn"
          />
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[13px] font-semibold">
              Run this command for {context}?
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-muted-foreground">
              Your kubeconfig gets this cluster's credentials from a program.
              Twigo runs it only if you trust it, and asks again if it changes.
            </DialogDescription>
          </div>
        </div>
        <Command plugin={auth.plugin} />
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              credentials.setTrustOpen(false);
            }}
          >
            Not now
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void credentials.trust(auth.plugin.digest);
            }}
          >
            Trust and connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The first start's list of every plugin the kubeconfigs name. */
export function ReviewDialog() {
  const { credentials } = useWorkbench();
  useChanges(credentials.changes);
  const { review } = credentials;
  const [kept, setKept] = useState<ReadonlySet<string> | undefined>();
  if (review.length === 0) return null;
  const chosen = kept ?? new Set(review.map((p) => p.plugin.digest));
  const toggle = (digest: string) => {
    const next = new Set(chosen);
    if (next.has(digest)) next.delete(digest);
    else next.add(digest);
    setKept(next);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void credentials.answerReview([]);
      }}
    >
      <DialogContent className="max-w-xl p-4">
        <div className="flex items-start gap-2.5">
          <ShieldAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-warn"
          />
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[13px] font-semibold">
              Trust the credential programs in your kubeconfig?
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-muted-foreground">
              These clusters get their credentials from programs your kubeconfig
              names. Twigo runs one only if you trust it; any you leave out ask
              when you open their cluster.
            </DialogDescription>
          </div>
        </div>
        <ul className="mt-3 max-h-80 space-y-2 overflow-auto">
          {review.map(({ plugin, contexts }: ReviewedPlugin) => (
            <li key={plugin.digest}>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-2.5 accent-brand"
                  checked={chosen.has(plugin.digest)}
                  onChange={() => {
                    toggle(plugin.digest);
                  }}
                />
                <div className="min-w-0 flex-1">
                  <Command plugin={plugin} />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {contexts.join(", ")}
                  </p>
                </div>
              </label>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void credentials.answerReview([]);
            }}
          >
            Ask me later
          </Button>
          <Button
            size="sm"
            disabled={chosen.size === 0}
            onClick={() => {
              void credentials.answerReview([...chosen]);
            }}
          >
            Trust {chosen.size === review.length ? "all" : "selected"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Command({ plugin }: { plugin: ExecPlugin }) {
  return (
    <div className="mt-3 rounded-md border border-border bg-muted p-2 font-mono text-[11px] leading-relaxed">
      <p className="break-all">
        <span className="font-semibold">{plugin.command}</span>{" "}
        {plugin.args.join(" ")}
      </p>
      {plugin.env.length > 0 && (
        <ul className="mt-1 text-muted-foreground">
          {plugin.env.map(({ name, value }) => (
            <li key={name} className="break-all">
              {name}={value}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

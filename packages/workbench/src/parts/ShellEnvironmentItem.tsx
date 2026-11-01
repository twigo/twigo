import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { ShellEnvironment } from "@twigo/protocol";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@twigo/ui";
import { useChanges, useWorkbench } from "../react";

type Failed = Extract<ShellEnvironment, { state: "failed" }>;

export const RETRY_SHELL_ENVIRONMENT = "workbench.action.retryShellEnvironment";
export const SHOW_SHELL_ENVIRONMENT = "workbench.action.showShellEnvironment";

const TITLE = "Shell environment not loaded";

/** A warning while Twigo runs without the login shell's environment (ARCHITECTURE 6.1). */
export function ShellEnvironmentItem() {
  const { shellEnvironment } = useWorkbench();
  useChanges(shellEnvironment.changes);
  const { current, detailsOpen } = shellEnvironment;
  if (current.state === "resolving" && shellEnvironment.retrying)
    return (
      <span className="flex h-6 items-center gap-1.5 px-1.5" role="status">
        <span aria-hidden className="size-1.5 rounded-full bg-warn" />
        Loading shell environment…
      </span>
    );
  if (current.state !== "failed") return null;
  return (
    <Popover
      open={detailsOpen}
      onOpenChange={(open) => {
        shellEnvironment.setDetailsOpen(open);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={TITLE}
          title={TITLE}
          className="flex h-6 items-center gap-1.5 px-1.5 hover:bg-statusbar-foreground/10"
        >
          <TriangleAlert aria-hidden className="size-3.5" />
          Shell environment
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-96 p-3 text-xs">
        <p className="text-[13px] font-semibold">{TITLE}</p>
        <p className="mt-1 text-muted-foreground">
          <span className="font-mono">{current.shell}</span> {current.reason},
          so Twigo runs tools with its own environment. Credential plugins on
          your shell's <span className="font-mono">PATH</span>, such as
          kubelogin or aws, may not be found.
        </p>
        <Details failed={current} />
      </PopoverContent>
    </Popover>
  );
}

function Details({ failed }: { failed: Failed }) {
  const { commands, keys } = useWorkbench();
  const [shown, setShown] = useState(false);
  const output = failed.output.trimEnd();
  return (
    <>
      {shown && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted p-2 font-mono text-[11px]">
          {output === "" ? "The shell printed nothing." : output}
        </pre>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setShown(!shown);
          }}
        >
          {shown ? "Hide details" : "Show details"}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            void commands.execute(RETRY_SHELL_ENVIRONMENT, keys.lookup(null));
          }}
        >
          Retry
        </Button>
      </div>
    </>
  );
}

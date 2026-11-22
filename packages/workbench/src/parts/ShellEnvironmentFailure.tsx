import { useState } from "react";
import type { ShellEnvironment } from "@twigo/protocol";
import { Button } from "@twigo/ui";
import { ErrorMessage } from "../ErrorMessage";
import { useWorkbench } from "../react";
import {
  RETRY_SHELL_ENVIRONMENT,
  SHELL_ENVIRONMENT_TITLE,
} from "./shellEnvironmentIds";

type Failed = Extract<ShellEnvironment, { state: "failed" }>;

/** Why the login shell's environment did not load, its output, and a retry (ARCHITECTURE 6.1). */
export function ShellEnvironmentFailure({ failed }: { failed: Failed }) {
  return (
    <>
      <p className="text-body font-semibold text-content">
        {SHELL_ENVIRONMENT_TITLE}
      </p>
      <p className="mt-1 text-support">
        <ErrorMessage
          error={failed.reason}
          message={`${failed.shell} ${failed.reason.message}`}
        />
      </p>
      <p className="mt-1 text-support">
        Twigo runs tools with its own environment. Credential plugins on your
        shell's <span className="font-mono">PATH</span>, such as kubelogin or
        aws, may not be found.
      </p>
      <Details failed={failed} />
    </>
  );
}

function Details({ failed }: { failed: Failed }) {
  const { commands, keys } = useWorkbench();
  const [shown, setShown] = useState(false);
  const output = failed.output.trimEnd();
  return (
    <>
      {shown && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted p-2 font-mono text-2xs">
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

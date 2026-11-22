import { CircleAlert } from "lucide-react";
import type { IpcError } from "@twigo/protocol";
import { EmptyState } from "@twigo/ui";
import { ErrorMessage } from "@twigo/workbench";

/** What the window shows when the workbench could not start. */
export function StartupFailure({ error }: { error: IpcError }) {
  return (
    <EmptyState
      icon={CircleAlert}
      variant="error"
      title="Twigo could not start"
      className="h-full"
    >
      <p className="text-support">
        <ErrorMessage error={error} />
      </p>
    </EmptyState>
  );
}

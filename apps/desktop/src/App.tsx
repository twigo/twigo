import { CircleAlert } from "lucide-react";
import { EmptyState } from "@twigo/ui";

/** What the window shows when the workbench could not start. */
export function StartupFailure({ message }: { message: string }) {
  return (
    <EmptyState
      icon={CircleAlert}
      variant="error"
      title="Twigo could not start"
      className="h-full"
    >
      <p className="text-muted-foreground">{message}</p>
    </EmptyState>
  );
}

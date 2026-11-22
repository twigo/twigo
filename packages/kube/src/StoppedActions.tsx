import { Button } from "@twigo/ui";
import { ReportButton } from "@twigo/workbench";

/** What a view that Twigo stopped offers: to open it again, where it can, and to report it (ARCHITECTURE 4.10). */
export function StoppedActions({
  onReopen,
}: {
  onReopen?: (() => void) | undefined;
}) {
  return (
    <span className="flex items-center gap-2">
      {onReopen && (
        <Button size="sm" variant="outline" onClick={onReopen}>
          Reopen
        </Button>
      )}
      <ReportButton />
    </span>
  );
}

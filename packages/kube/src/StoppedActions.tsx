import { LinkButton } from "@twigo/ui";
import { ReportLink } from "@twigo/workbench";

/** What a view that Twigo stopped offers: to open it again, where it can, and to report it (ARCHITECTURE 4.10). */
export function StoppedActions({
  onReopen,
}: {
  onReopen?: (() => void) | undefined;
}) {
  return (
    <span className="flex items-center gap-3 text-xs">
      {onReopen && <LinkButton onClick={onReopen}>Reopen</LinkButton>}
      <ReportLink />
    </span>
  );
}

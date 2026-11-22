import { CircleAlert } from "lucide-react";
import { Banner, LinkButton } from "@twigo/ui";
import { INTERNAL_ERROR, ReportLink } from "@twigo/workbench";

/** Over a shell or a terminal that Twigo's own code stopped: it can be opened again, though not resumed. */
export function InternalStop({ reopen }: { reopen: () => void }) {
  return (
    <Banner
      tone="error"
      icon={CircleAlert}
      title={`${INTERNAL_ERROR.title}.`}
      action={
        <span className="flex items-center gap-3 text-xs">
          <LinkButton onClick={reopen}>Reopen</LinkButton>
          <ReportLink />
        </span>
      }
    >
      {INTERNAL_ERROR.stopped("This shell")}
    </Banner>
  );
}

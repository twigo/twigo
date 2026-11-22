import { CircleAlert } from "lucide-react";
import { Banner } from "@twigo/ui";
import { ErrorMessage, INTERNAL_ERROR, type ErrorLike } from "@twigo/workbench";
import { StoppedActions } from "../StoppedActions";

export function InternalStop({
  error,
  reopen,
}: {
  error: ErrorLike;
  reopen: () => void;
}) {
  return (
    <Banner
      tone="error"
      icon={CircleAlert}
      title={`${INTERNAL_ERROR.title}.`}
      action={<StoppedActions onReopen={reopen} />}
    >
      <ErrorMessage
        error={error}
        message={INTERNAL_ERROR.stopped("This shell")}
      />
    </Banner>
  );
}

import { CircleAlert } from "lucide-react";
import { ErrorBanner, INTERNAL_ERROR, type ErrorLike } from "@twigo/workbench";
import { StoppedActions } from "../StoppedActions";

export function InternalStop({
  error,
  reopen,
}: {
  error: ErrorLike;
  reopen: () => void;
}) {
  return (
    <ErrorBanner
      tone="error"
      icon={CircleAlert}
      title={`${INTERNAL_ERROR.title}.`}
      action={<StoppedActions onReopen={reopen} />}
      error={error}
      message={INTERNAL_ERROR.stopped("This shell")}
    />
  );
}

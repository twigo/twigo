import { CircleAlert } from "lucide-react";
import { ErrorBanner, INTERNAL_ERROR, type ErrorLike } from "@twigo/workbench";
import { StoppedActions } from "./StoppedActions";

export function InternalStop({
  error,
  reopen,
  what = "This shell",
}: {
  error: ErrorLike;
  reopen: () => void;
  what?: string;
}) {
  return (
    <ErrorBanner
      tone="error"
      icon={CircleAlert}
      title={`${INTERNAL_ERROR.title}.`}
      action={<StoppedActions onReopen={reopen} />}
      error={error}
      message={INTERNAL_ERROR.stopped(what)}
    />
  );
}

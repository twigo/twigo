import type { ComponentProps, ReactNode } from "react";
import { Banner } from "@twigo/ui";
import { ErrorCode } from "./ErrorMessage";
import type { ErrorLike } from "./errors";

/**
 * A banner that says an error: its message on the first line, which is cut
 * at its end, then `children`, and the code's line under them.
 */
export function ErrorBanner({
  error,
  message = error.message,
  children,
  ...banner
}: Omit<ComponentProps<typeof Banner>, "children" | "detail"> & {
  error: ErrorLike;
  message?: string;
  children?: ReactNode;
}) {
  return (
    <Banner {...banner} detail={<ErrorCode error={error} />}>
      {message}
      {children !== undefined && <> {children}</>}
    </Banner>
  );
}

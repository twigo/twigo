import type { ComponentProps, ReactNode } from "react";
import { Banner } from "@twigo/ui";
import { errorParts } from "./errorParts";
import type { ErrorLike } from "./errors";

/**
 * A banner that says an error: its message on the first line, which is cut
 * at its end, then `children`, and the code's line under them.
 */
export function ErrorBanner({
  error,
  message,
  children,
  ...banner
}: Omit<ComponentProps<typeof Banner>, "children" | "detail"> & {
  error: ErrorLike;
  /** Says the error in other words than its own. */
  message?: string;
  children?: ReactNode;
}) {
  const { words, details } = errorParts({
    error,
    ...(message !== undefined && { message }),
  });
  return (
    <Banner {...banner} detail={details}>
      {words}
      {children !== undefined && <> {children}</>}
    </Banner>
  );
}

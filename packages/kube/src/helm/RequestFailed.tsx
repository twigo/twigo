import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

/**
 * A status with the mark that a request for the revision it is read from
 * failed, which leaves the status the one on the Secret's label: the status is
 * cut first, the mark stays.
 */
export function RequestFailed({
  code,
  what,
  children,
}: {
  code: string;
  /** The revision the request was for, as the tooltip and the mark's name say it. */
  what: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 align-top">
      <span className="min-w-0 truncate">{children}</span>
      <span
        title={`Twigo could not fetch ${what} (${code}), so its status is the one on the Secret's label. Twigo asks again.`}
        className="inline-flex shrink-0"
      >
        <TriangleAlert
          role="img"
          aria-label={`Could not fetch ${what}`}
          className="size-3.5 text-warn-foreground"
        />
      </span>
    </span>
  );
}

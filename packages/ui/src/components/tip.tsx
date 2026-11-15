import { Lock } from "lucide-react";

/** What a button's tooltip says: its label and keys, and why it cannot run or what its lock will answer. */
export function ButtonTip({
  label,
  keys,
  reason,
  locked = false,
}: {
  label: string;
  keys?: string | undefined;
  reason?: string | undefined;
  locked?: boolean | undefined;
}) {
  return (
    <>
      <span className="flex items-center gap-2">
        <span>{label}</span>
        {keys && <span className="text-support">{keys}</span>}
      </span>
      {reason !== undefined && (
        <span className="flex items-center gap-1 text-support">
          {locked && <Lock aria-hidden className="size-3" />}
          {reason}
        </span>
      )}
    </>
  );
}

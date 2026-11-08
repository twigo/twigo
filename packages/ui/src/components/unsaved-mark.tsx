import { cn } from "../lib/cn";

/** A filled dot for changes nothing has applied yet: an editor's tab wears it where its close button is. */
export function UnsavedMark({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Unsaved changes"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full bg-foreground",
        className,
      )}
    />
  );
}

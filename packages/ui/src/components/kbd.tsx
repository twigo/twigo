import { cn } from "../lib/cn";

// A keycap chip for shortcut hints. Pair with fmtBinding() so the glyphs match
// the platform; this just standardizes how a shortcut looks everywhere. The
// thicker bottom edge gives the cap its depth.
export function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-b-2 border-border bg-editor px-1 font-sans text-[11px] leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

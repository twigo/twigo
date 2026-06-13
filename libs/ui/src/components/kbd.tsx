import { cn } from "../lib/cn";

// A keycap chip for shortcut hints. Pair with fmtBinding() so the glyphs match
// the platform; this just standardizes how a shortcut looks everywhere. The
// inset bottom edge gives the cap physical depth without a real shadow.
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
        "inline-flex h-[18px] items-center rounded border border-border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground shadow-[inset_0_-1.5px_0_color-mix(in_oklab,var(--foreground)_9%,transparent)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

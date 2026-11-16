import { cn } from "../lib/cn";

// A keycap chip for shortcut hints. Pair with fmtBinding() so the glyphs match
// the platform; this just standardizes how a shortcut looks everywhere.
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
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm bg-row-active px-1 font-sans text-2xs leading-none text-support",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

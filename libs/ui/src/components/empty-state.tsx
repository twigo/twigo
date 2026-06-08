import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";

// Centered placeholder for empty / loading / error regions. The caller controls
// outer sizing via className (h-full, flex-1, …); this only standardizes the
// inner layout and colour so states stop drifting apart.
export function EmptyState({
  icon: Icon,
  variant = "muted",
  className,
  children,
}: {
  icon?: LucideIcon;
  variant?: "muted" | "error";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 text-center text-sm",
        variant === "error" ? "text-error" : "text-muted-foreground",
        className,
      )}
    >
      {Icon && <Icon className="size-8 opacity-30" />}
      {children}
    </div>
  );
}

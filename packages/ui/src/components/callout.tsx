import type { ReactNode } from "react";
import { CircleAlert, TriangleAlert } from "lucide-react";
import { cn } from "../lib/cn";

const TINT = {
  error:
    "bg-error/8 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--error)_25%,transparent)]",
  warn: "bg-warn/10 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--warn)_35%,transparent)]",
} as const;

const TITLE = {
  error: { icon: CircleAlert, className: "text-error" },
  warn: { icon: TriangleAlert, className: "text-warn-foreground" },
} as const;

/**
 * What is wrong, in words, on its tone's tint with its title in the tone:
 * an object's diagnostics. The tone has its own icon, so it does not rest
 * on hue alone. It is no live region: it is there when its view opens,
 * and its times tick, which a screen reader would read out each second.
 */
export function Callout({
  tone,
  title,
  children,
  className,
}: {
  tone: keyof typeof TINT;
  title: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, className: titleClass } = TITLE[tone];
  return (
    <div
      className={cn(
        "grid gap-1.5 rounded-md px-3 py-2.5",
        TINT[tone],
        className,
      )}
    >
      <div
        className={cn("flex items-center gap-1.5 font-semibold", titleClass)}
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0">{title}</span>
      </div>
      {children}
    </div>
  );
}

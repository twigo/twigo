import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import type { Tone } from "../lib/tone";

const TEXT: Readonly<Record<Tone, string>> = {
  error: "text-error",
  warn: "text-warn-foreground",
  ok: "",
  idle: "text-muted-foreground",
};

/** Words in their tone's colour, without a dot: a Ready of `0/1`. */
export function TonedText({
  tone,
  className,
  children,
}: {
  tone: Tone;
  className?: string;
  children: ReactNode;
}) {
  return <span className={cn(TEXT[tone], className)}>{children}</span>;
}

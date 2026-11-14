import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["2xs", "label", "body", "prose", "title"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import type { FunctionComponent } from "react";

// Status-bar segments. The shell renders a brand-coloured bar with two clusters
// (left/right) and its own chrome (palette, theme); domain modules contribute
// segments - each a self-contained component that reads whatever stores it needs
// - so the shell never imports connection/stream state to draw the bar.

export interface StatusSegment {
  id: string;
  side: "left" | "right";
  order?: number;
  render: FunctionComponent;
}

const segments: StatusSegment[] = [];

export function registerStatusSegment(seg: StatusSegment): void {
  segments.push(seg);
}

export function getStatusSegments(
  side: StatusSegment["side"],
): StatusSegment[] {
  return segments
    .filter((s) => s.side === side)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// Test-only: drop registered segments so a suite starts clean.
export function clearStatusSegments(): void {
  segments.length = 0;
}

// Shared treatment for an interactive segment sitting on the brand-coloured bar.
export const statusSegmentClass =
  "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors duration-100 hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50";

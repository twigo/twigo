import type { FunctionComponent } from "react";

// The editor area's zero-state. A domain module contributes the content shown
// when no tabs are open (e.g. NATS' "pick a subject" / quickstart); the shell
// only knows there is a watermark to render, never what it says. Function
// components only - the host (Dockview) renders it as one.

let watermark: FunctionComponent | null = null;

export function registerWatermark(component: FunctionComponent): void {
  watermark = component;
}

export function getWatermark(): FunctionComponent | null {
  return watermark;
}

// Test-only: drop the registered watermark so a suite starts clean.
export function clearWatermark(): void {
  watermark = null;
}

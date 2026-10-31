import type { Platform } from "./chord";

/** The platform the webview runs on, from its user agent. */
export function platformOf(userAgent: string): Platform {
  if (/Mac OS X|Macintosh/.test(userAgent)) return "mac";
  if (userAgent.includes("Windows")) return "win";
  return "linux";
}

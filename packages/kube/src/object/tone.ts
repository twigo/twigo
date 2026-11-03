import type { Tone as Told } from "@twigo/protocol";
import type { Tone } from "@twigo/ui";

/** The tone Rust tells for a value, as `ui` draws tones. */
export const TONE: Readonly<Record<Told, Tone>> = {
  success: "ok",
  danger: "error",
  warning: "warn",
  neutral: "idle",
};

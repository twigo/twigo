import { encodeText } from "@twigo/utils";
import type { PickedPayload } from "@/lib/api";

export type PayloadMode = "json" | "text" | "binary" | "file";

export const PAYLOAD_MODES: { key: PayloadMode; label: string }[] = [
  { key: "json", label: "JSON" },
  { key: "text", label: "Text" },
  { key: "binary", label: "Base64" },
  { key: "file", label: "File" },
];

export function isBase64(s: string): boolean {
  const stripped = s.replace(/\s/g, "");
  return stripped.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(stripped);
}

export function wirePayload(
  mode: PayloadMode,
  text: string,
  file: PickedPayload | null,
): string | null {
  switch (mode) {
    case "json":
    case "text":
      return encodeText(text);
    case "binary": {
      const stripped = text.replace(/\s/g, "");
      return isBase64(stripped) ? stripped : null;
    }
    case "file":
      return file?.payloadB64 ?? null;
  }
}

import { encodeText } from "@twigo/utils";
import type { CodecId, PickedPayload } from "@/lib/api";

export type PayloadMode = "json" | "text" | "binary" | "file" | CodecId;

export const PAYLOAD_MODES: { key: PayloadMode; label: string }[] = [
  { key: "json", label: "JSON" },
  { key: "text", label: "Text" },
  { key: "binary", label: "Base64" },
  { key: "file", label: "File" },
  { key: "protobuf", label: "Protobuf" },
  { key: "msgpack", label: "MessagePack" },
  { key: "cbor", label: "CBOR" },
];

export const CODEC_MODES: CodecId[] = ["protobuf", "msgpack", "cbor"];

export function isCodecMode(mode: PayloadMode): mode is CodecId {
  return (CODEC_MODES as string[]).includes(mode);
}

export function isBase64(s: string): boolean {
  const stripped = s.replace(/\s/g, "");
  if (stripped.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) {
    return false;
  }
  try {
    // Canonical round-trip: the Rust decoder rejects non-zero trailing bits.
    return btoa(atob(stripped)) === stripped;
  } catch {
    return false;
  }
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
    default:
      return null;
  }
}

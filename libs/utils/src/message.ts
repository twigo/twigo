export interface StreamMessage {
  id: number;
  receivedAt: number;
  subject: string;
  reply: string | null;
  payloadB64: string;
  headers: [string, string][];
  size: number;
  preview: string;
}

function decodeBytes(payloadB64: string): Uint8Array {
  const binary = atob(payloadB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode a base64 payload to UTF-8 text (lossy) for display. */
export function decodeText(payloadB64: string): string {
  return new TextDecoder().decode(decodeBytes(payloadB64));
}

/** Encode UTF-8 text to a base64 payload (inverse of decodeText). */
export function encodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Single-line, truncated preview of a payload for the message table. */
export function decodePreview(payloadB64: string, max = 200): string {
  const text = decodeText(payloadB64).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Pretty-print the payload as JSON, or null if it isn't valid JSON. */
export function tryPrettyJson(payloadB64: string): string | null {
  try {
    return JSON.stringify(JSON.parse(decodeText(payloadB64)), null, 2);
  } catch {
    return null;
  }
}

/** Space-separated hex dump of the payload bytes. */
export function toHex(payloadB64: string): string {
  return Array.from(decodeBytes(payloadB64))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

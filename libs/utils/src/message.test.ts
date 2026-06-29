import { describe, it, expect } from "vitest";
import {
  decodeText,
  encodeText,
  decodePreview,
  tryPrettyJson,
  toHex,
} from "./message";

describe("message decoding", () => {
  it("decodes base64 to text", () => {
    // "hello" -> aGVsbG8=
    expect(decodeText("aGVsbG8=")).toBe("hello");
  });

  it("encodeText round-trips through decodeText (incl. non-ASCII)", () => {
    for (const s of ["hello", '{"a":1}', "héllo · 世界", ""]) {
      expect(decodeText(encodeText(s))).toBe(s);
    }
  });

  it("collapses whitespace in previews", () => {
    // '{"a":\n 1}' base64
    const b64 = btoa('{"a":\n 1}');
    expect(decodePreview(b64)).toBe('{"a": 1}');
  });

  it("truncates long previews", () => {
    const b64 = btoa("x".repeat(50));
    expect(decodePreview(b64, 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("truncates at the default length without decoding the whole payload", () => {
    // A payload far larger than the bounded head still previews to max + ellipsis.
    const b64 = btoa("a".repeat(100_000));
    const preview = decodePreview(b64);
    expect(preview).toBe(`${"a".repeat(200)}…`);
  });

  it("previews multi-byte UTF-8 near the boundary without mojibake", () => {
    // 300 three-byte chars: more than max, so it truncates cleanly to 200 + …
    const b64 = encodeText("世".repeat(300));
    const preview = decodePreview(b64);
    expect(preview).toBe(`${"世".repeat(200)}…`);
  });

  it("pretty-prints JSON payloads", () => {
    expect(tryPrettyJson(btoa('{"a":1}'))).toBe('{\n  "a": 1\n}');
  });

  it("returns null for non-JSON payloads", () => {
    expect(tryPrettyJson(btoa("not json"))).toBeNull();
  });

  it("renders a hex dump", () => {
    expect(toHex(btoa("AB"))).toBe("41 42");
  });
});

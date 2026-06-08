import { describe, it, expect } from "vitest";
import { decodeText, decodePreview, tryPrettyJson, toHex } from "./message";

describe("message decoding", () => {
  it("decodes base64 to text", () => {
    // "hello" -> aGVsbG8=
    expect(decodeText("aGVsbG8=")).toBe("hello");
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

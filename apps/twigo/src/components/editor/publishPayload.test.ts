import { describe, it, expect } from "vitest";
import { isBase64, wirePayload } from "./publishPayload";

describe("isBase64", () => {
  it("accepts padded base64 and whitespace", () => {
    expect(isBase64("aGk=")).toBe(true);
    expect(isBase64("aGVs\nbG8=")).toBe(true);
    expect(isBase64("")).toBe(true);
  });

  it("rejects junk and bad lengths", () => {
    expect(isBase64("not base64!")).toBe(false);
    expect(isBase64("abc")).toBe(false);
  });
});

describe("wirePayload", () => {
  it("encodes json/text modes", () => {
    expect(wirePayload("json", "hi", null)).toBe(btoa("hi"));
    expect(wirePayload("text", "hi", null)).toBe(btoa("hi"));
  });

  it("passes valid base64 through stripped, null when invalid", () => {
    expect(wirePayload("binary", "aGk =", null)).toBe("aGk=");
    expect(wirePayload("binary", "nope!", null)).toBeNull();
  });

  it("uses the picked file or blocks", () => {
    expect(wirePayload("file", "", null)).toBeNull();
    expect(
      wirePayload("file", "", { name: "a.bin", size: 2, payloadB64: "aGk=" }),
    ).toBe("aGk=");
  });
});

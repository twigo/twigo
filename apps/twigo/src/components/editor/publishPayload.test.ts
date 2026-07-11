import { describe, it, expect } from "vitest";
import { isBase64, isCodecMode, wirePayload } from "./publishPayload";

describe("isBase64", () => {
  it("accepts padded base64 and whitespace", () => {
    expect(isBase64("aGk=")).toBe(true);
    expect(isBase64("aGVs\nbG8=")).toBe(true);
    expect(isBase64("")).toBe(true);
  });

  it("rejects junk, bad lengths and non-canonical trailing bits", () => {
    expect(isBase64("not base64!")).toBe(false);
    expect(isBase64("abc")).toBe(false);
    expect(isBase64("ab==")).toBe(false);
  });
});

describe("isCodecMode", () => {
  it("recognizes the schema/rust-backed modes", () => {
    expect(isCodecMode("protobuf")).toBe(true);
    expect(isCodecMode("msgpack")).toBe(true);
    expect(isCodecMode("cbor")).toBe(true);
    expect(isCodecMode("json")).toBe(false);
    expect(isCodecMode("file")).toBe(false);
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

  it("returns null for codec modes (encoded async elsewhere)", () => {
    expect(wirePayload("protobuf", "{}", null)).toBeNull();
    expect(wirePayload("msgpack", "{}", null)).toBeNull();
  });
});

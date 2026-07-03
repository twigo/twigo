import { describe, it, expect, beforeEach, vi } from "vitest";

const { codecDecode, codecEncode } = vi.hoisted(() => ({
  codecDecode: vi.fn(),
  codecEncode: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ codecDecode, codecEncode }));

import { decodePayload, encodePayload, defaultTarget } from "./codecs";
import { useCodecs } from "@/store/codecs";
import { encodeText } from "@twigo/utils";

describe("decodePayload built-ins", () => {
  it("pretty-prints JSON, falls back to text, and hex-dumps", async () => {
    expect(
      await decodePayload(encodeText('{"a":1}'), {
        kind: "builtin",
        format: "json",
      }),
    ).toEqual({ text: '{\n  "a": 1\n}', language: "json" });
    expect(
      await decodePayload(encodeText("hi"), {
        kind: "builtin",
        format: "text",
      }),
    ).toEqual({ text: "hi", language: "text" });
    expect(
      await decodePayload(encodeText("A"), { kind: "builtin", format: "hex" }),
    ).toEqual({ text: "41", language: "text" });
  });
});

describe("codec targets go through the Rust bridge with the schema bytes", () => {
  beforeEach(() => {
    useCodecs.setState({ schemas: [], mappings: {} });
    codecDecode.mockReset().mockResolvedValue('{"ok":true}');
    codecEncode.mockReset().mockResolvedValue("YmFzZTY0");
  });

  it("passes the resolved descriptor set and type for protobuf", async () => {
    useCodecs.getState().addSchema({
      name: "s",
      descriptorSetB64: "DESC",
      messageTypes: ["pkg.Msg"],
    });
    const schemaId = useCodecs.getState().schemas[0]!.id;
    const target = {
      kind: "codec" as const,
      codec: "protobuf" as const,
      schemaId,
      messageType: "pkg.Msg",
    };

    const decoded = await decodePayload("AAA=", target);
    expect(decoded).toEqual({ text: '{"ok":true}', language: "json" });
    expect(codecDecode).toHaveBeenCalledWith("AAA=", {
      codec: "protobuf",
      descriptorSetB64: "DESC",
      messageType: "pkg.Msg",
    });

    await encodePayload('{"x":1}', target);
    expect(codecEncode).toHaveBeenCalledWith('{"x":1}', {
      codec: "protobuf",
      descriptorSetB64: "DESC",
      messageType: "pkg.Msg",
    });
  });

  it("sends no schema for schemaless codecs", async () => {
    await decodePayload("AAA=", { kind: "codec", codec: "msgpack" });
    expect(codecDecode).toHaveBeenCalledWith("AAA=", {
      codec: "msgpack",
      descriptorSetB64: undefined,
      messageType: undefined,
    });
  });
});

describe("defaultTarget", () => {
  beforeEach(() => useCodecs.setState({ schemas: [], mappings: {} }));

  it("uses a matching mapping, else plain JSON", () => {
    expect(defaultTarget("c", "x.y")).toEqual({
      kind: "builtin",
      format: "json",
    });
    useCodecs
      .getState()
      .addMapping("c", { pattern: "orders.>", codec: "cbor" });
    expect(defaultTarget("c", "orders.paid")).toMatchObject({
      kind: "codec",
      codec: "cbor",
    });
  });
});

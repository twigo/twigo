import { describe, it, expect, beforeEach } from "vitest";
import { useCodecs, subjectMatches } from "./codecs";

describe("subjectMatches", () => {
  it("matches literals and wildcards", () => {
    expect(subjectMatches("orders.created", "orders.created")).toBe(true);
    expect(subjectMatches("orders.*", "orders.created")).toBe(true);
    expect(subjectMatches("orders.*", "orders.a.b")).toBe(false);
    expect(subjectMatches("orders.>", "orders.a.b")).toBe(true);
    expect(subjectMatches("orders.>", "orders")).toBe(false);
    expect(subjectMatches("orders.created", "orders.updated")).toBe(false);
    expect(subjectMatches("a.*.c", "a.b.c")).toBe(true);
  });
});

describe("useCodecs", () => {
  beforeEach(() => useCodecs.setState({ schemas: [], mappings: {} }));

  it("removes a schema and its mappings together", () => {
    useCodecs.getState().addSchema({
      name: "s",
      descriptorSetB64: "x",
      messageTypes: ["A"],
    });
    const id = useCodecs.getState().schemas[0]!.id;
    useCodecs.getState().addMapping("c", {
      pattern: "a.>",
      codec: "protobuf",
      schemaId: id,
      messageType: "A",
    });
    useCodecs.getState().removeSchema(id);
    expect(useCodecs.getState().schemas).toHaveLength(0);
    expect(useCodecs.getState().mappings.c).toHaveLength(0);
  });

  it("resolves the most specific matching mapping", () => {
    const add = useCodecs.getState().addMapping;
    add("c", { pattern: "orders.>", codec: "cbor" });
    add("c", { pattern: "orders.created", codec: "msgpack" });
    expect(useCodecs.getState().resolve("c", "orders.created")?.codec).toBe(
      "msgpack",
    );
    expect(useCodecs.getState().resolve("c", "orders.paid")?.codec).toBe(
      "cbor",
    );
    expect(useCodecs.getState().resolve("c", "audit.x")).toBeNull();
  });
});

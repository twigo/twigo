import { describe, it, expect, beforeEach } from "vitest";
import { useCodecs, subjectMatches, validPattern } from "./codecs";

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

describe("validPattern", () => {
  it("accepts NATS patterns and rejects malformed ones", () => {
    expect(validPattern("orders.>")).toBe(true);
    expect(validPattern("orders.*.created")).toBe(true);
    expect(validPattern("a.>.b")).toBe(false);
    expect(validPattern("a..b")).toBe(false);
    expect(validPattern("")).toBe(false);
  });
});

describe("useCodecs", () => {
  beforeEach(() => useCodecs.setState({ schemas: [], mappings: {} }));

  it("prefers a bounded pattern over a > tail regardless of insert order", () => {
    const add = useCodecs.getState().addMapping;
    add("c", { pattern: "orders.>", codec: "cbor" });
    add("c", { pattern: "orders.*", codec: "msgpack" });

    expect(useCodecs.getState().resolve("c", "orders.created")?.codec).toBe(
      "msgpack",
    );
    expect(useCodecs.getState().resolve("c", "orders.eu.created")?.codec).toBe(
      "cbor",
    );
  });

  it("re-imports a schema in place so mappings keep decoding", () => {
    const add = useCodecs.getState().addSchema;
    add({ name: "orders", descriptorSetB64: "v1", messageTypes: ["A"] });
    const id = useCodecs.getState().schemas[0]!.id;
    useCodecs
      .getState()
      .addMapping("c", { pattern: "a.>", codec: "protobuf", schemaId: id });

    add({ name: "orders", descriptorSetB64: "v2", messageTypes: ["A", "B"] });

    expect(useCodecs.getState().schemas).toEqual([
      { id, name: "orders", descriptorSetB64: "v2", messageTypes: ["A", "B"] },
    ]);
    expect(useCodecs.getState().schemaById(id)?.descriptorSetB64).toBe("v2");
  });

  it("drops a deleted context's mappings without touching other contexts", () => {
    const add = useCodecs.getState().addMapping;
    add("gone", { pattern: "a.>", codec: "cbor" });
    add("kept", { pattern: "b.>", codec: "msgpack" });

    useCodecs.getState().clearConn("gone");

    expect(useCodecs.getState().mappings.gone).toBeUndefined();
    expect(useCodecs.getState().mappings.kept).toHaveLength(1);
    expect(useCodecs.getState().resolve("gone", "a.x")).toBeNull();
  });

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

  it("replaces a mapping with the same pattern, keeping its id", () => {
    const add = useCodecs.getState().addMapping;
    add("c", { pattern: "orders.>", codec: "cbor" });
    const id = useCodecs.getState().mappings.c![0]!.id;
    add("c", { pattern: "orders.>", codec: "msgpack" });
    expect(useCodecs.getState().mappings.c).toEqual([
      { id, pattern: "orders.>", codec: "msgpack" },
    ]);
  });

  it("resolves the mapping with the most literal tokens", () => {
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

    add("c", { pattern: "*.created", codec: "protobuf" });
    expect(useCodecs.getState().resolve("c", "orders.created")?.codec).toBe(
      "msgpack",
    );
  });
});

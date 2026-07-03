import { describe, it, expect } from "vitest";
import { parseRawConfig, diffRawConfig } from "./rawConfig";

describe("parseRawConfig", () => {
  it("rejects junk, non-objects and renames", () => {
    expect(parseRawConfig("{", "S").ok).toBe(false);
    expect(parseRawConfig("[1]", "S").ok).toBe(false);
    expect(parseRawConfig('{"name":"OTHER"}', "S").ok).toBe(false);
  });

  it("accepts a matching object", () => {
    const r = parseRawConfig('{"name":"S","max_msgs":5}', "S");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.max_msgs).toBe(5);
  });
});

describe("diffRawConfig", () => {
  it("reports added, removed and changed keys only", () => {
    const changes = diffRawConfig(
      { name: "S", max_msgs: 5, republish: { src: ">" } },
      { name: "S", max_msgs: 9, deny_delete: true },
    );
    expect(changes).toEqual([
      { key: "max_msgs", kind: "changed", from: "5", to: "9" },
      { key: "republish", kind: "removed", from: '{"src":">"}' },
      { key: "deny_delete", kind: "added", to: "true" },
    ]);
    expect(diffRawConfig({ name: "S" }, { name: "S" })).toEqual([]);
  });
});

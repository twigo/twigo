import { describe, it, expect } from "vitest";
import { bumpJson, bumpCargo } from "./set-version.mjs";

describe("set-version", () => {
  it("rewrites the JSON version field and preserves other keys + order", () => {
    const out = bumpJson(
      '{\n  "name": "twigo",\n  "version": "0.1.0"\n}\n',
      "0.2.0-beta1",
    );
    const data = JSON.parse(out);
    expect(data.version).toBe("0.2.0-beta1");
    expect(data.name).toBe("twigo");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("rewrites only the [package] version in Cargo.toml", () => {
    const cargo = [
      "[package]",
      'name = "twigo"',
      'version = "0.1.0"',
      'edition = "2021"',
      "",
      "[dependencies]",
      'tauri = { version = "2" }',
      "",
    ].join("\n");
    const out = bumpCargo(cargo, "0.2.0-beta1");
    expect(out).toContain('version = "0.2.0-beta1"');
    // The inline dependency version must stay untouched.
    expect(out).toContain('tauri = { version = "2" }');
  });
});

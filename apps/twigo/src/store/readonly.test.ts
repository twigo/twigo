import { describe, it, expect, beforeEach } from "vitest";
import { useReadOnly } from "./readonly";

describe("read-only store", () => {
  beforeEach(() => useReadOnly.setState({ byConn: {} }));

  it("defaults to writable", () => {
    expect(useReadOnly.getState().isReadOnly("prod")).toBe(false);
  });

  it("locks and unlocks a connection, dropping the key when unlocked", () => {
    useReadOnly.getState().setReadOnly("prod", true);
    expect(useReadOnly.getState().isReadOnly("prod")).toBe(true);
    useReadOnly.getState().setReadOnly("prod", false);
    expect(useReadOnly.getState().isReadOnly("prod")).toBe(false);
    expect("prod" in useReadOnly.getState().byConn).toBe(false);
  });

  it("toggle flips the lock", () => {
    useReadOnly.getState().toggle("dev");
    expect(useReadOnly.getState().isReadOnly("dev")).toBe(true);
    useReadOnly.getState().toggle("dev");
    expect(useReadOnly.getState().isReadOnly("dev")).toBe(false);
  });

  it("keeps locks independent per connection", () => {
    useReadOnly.getState().setReadOnly("prod", true);
    expect(useReadOnly.getState().isReadOnly("dev")).toBe(false);
  });
});

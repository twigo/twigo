import { describe, it, expect } from "vitest";
import { IpcError, ipcError } from "./api";

describe("IpcError", () => {
  it("stringifies to just the message (keeps String(e) sites clean)", () => {
    const e = new IpcError("notConnected", "not connected to 'dev'");
    expect(String(e)).toBe("not connected to 'dev'");
    expect(e.toString()).toBe("not connected to 'dev'");
    expect(e).toBeInstanceOf(Error);
    expect(e.kind).toBe("notConnected");
  });
});

describe("ipcError", () => {
  it("normalizes a backend { kind, message } payload", () => {
    const e = ipcError({
      kind: "credentials",
      message: "invalid credentials: bad nkey",
    });
    expect(e).toBeInstanceOf(IpcError);
    expect(e.kind).toBe("credentials");
    expect(e.message).toBe("invalid credentials: bad nkey");
  });

  it("degrades unknown shapes to kind 'unknown'", () => {
    expect(ipcError("boom").kind).toBe("unknown");
    expect(ipcError("boom").message).toBe("boom");
    expect(ipcError(new Error("oops")).message).toBe("oops");
  });

  it("passes an existing IpcError through unchanged", () => {
    const original = new IpcError("k", "m");
    expect(ipcError(original)).toBe(original);
  });
});

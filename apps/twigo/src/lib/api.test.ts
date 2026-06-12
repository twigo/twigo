import { describe, it, expect, beforeEach, vi } from "vitest";
import { IpcError, ipcError, publish, kvListKeys } from "./api";
import { useReadOnly } from "@/store/readonly";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  Channel: class {
    onmessage: ((m: unknown) => void) | null = null;
  },
}));

describe("read-only guard", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    useReadOnly.setState({ byConn: {} });
  });

  it("blocks a write on a read-only connection before it hits the backend", async () => {
    useReadOnly.getState().setReadOnly("prod", true);
    await expect(publish("prod", "orders.new", "x")).rejects.toMatchObject({
      kind: "readOnly",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("allows the same write when the connection is writable", async () => {
    await publish("dev", "orders.new", "x");
    expect(invokeMock).toHaveBeenCalledWith(
      "publish",
      expect.objectContaining({ connId: "dev" }),
    );
  });

  it("never blocks reads, even on a read-only connection", async () => {
    useReadOnly.getState().setReadOnly("prod", true);
    await kvListKeys("prod", "config");
    expect(invokeMock).toHaveBeenCalledWith(
      "kv_list_keys",
      expect.objectContaining({ connId: "prod" }),
    );
  });
});

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

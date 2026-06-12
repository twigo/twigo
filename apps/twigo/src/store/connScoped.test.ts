import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerConnScoped,
  resetConnScopedStores,
  clearConnScopedRegistry,
} from "./connScoped";

describe("connScoped registry", () => {
  beforeEach(() => clearConnScopedRegistry());

  it("resets every registered store for the given connection", () => {
    const a = vi.fn();
    const b = vi.fn();
    registerConnScoped({ getState: () => ({ reset: a }) });
    registerConnScoped({ getState: () => ({ reset: b }) });

    resetConnScopedStores("dev");

    expect(a).toHaveBeenCalledWith("dev");
    expect(b).toHaveBeenCalledWith("dev");
  });

  it("stops resetting a store once the registry is cleared", () => {
    const reset = vi.fn();
    registerConnScoped({ getState: () => ({ reset }) });
    clearConnScopedRegistry();

    resetConnScopedStores("dev");

    expect(reset).not.toHaveBeenCalled();
  });

  it("registers a store only once", () => {
    const reset = vi.fn();
    const store = { getState: () => ({ reset }) };
    registerConnScoped(store);
    registerConnScoped(store);

    resetConnScopedStores("dev");

    expect(reset).toHaveBeenCalledTimes(1);
  });
});

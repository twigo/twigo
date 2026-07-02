import { describe, it, expect, beforeEach } from "vitest";
import { Radio } from "lucide-react";
import {
  registerDomain,
  getDomains,
  getDomain,
  getDefaultDomainId,
  clearDomains,
} from "./domains";

describe("domain registry", () => {
  beforeEach(() => clearDomains());

  it("looks up domains and lists them ordered by `order`", () => {
    registerDomain({ id: "b", title: "B", icon: Radio, order: 2 });
    registerDomain({ id: "a", title: "A", icon: Radio, order: 1 });
    expect(getDomains().map((d) => d.id)).toEqual(["a", "b"]);
    expect(getDomain("a")?.title).toBe("A");
    expect(getDomain("missing")).toBeUndefined();
  });

  it("replaces a domain when its id is registered again", () => {
    registerDomain({ id: "a", title: "First", icon: Radio });
    registerDomain({ id: "a", title: "Second", icon: Radio });
    expect(getDomains()).toHaveLength(1);
    expect(getDomain("a")?.title).toBe("Second");
  });

  describe("getDefaultDomainId", () => {
    it("returns the opted-in default over registration order", () => {
      registerDomain({ id: "a", title: "A", icon: Radio });
      registerDomain({ id: "b", title: "B", icon: Radio, default: true });
      expect(getDefaultDomainId()).toBe("b");
    });

    it("falls back to the first domain when none is marked default", () => {
      registerDomain({ id: "a", title: "A", icon: Radio });
      registerDomain({ id: "b", title: "B", icon: Radio });
      expect(getDefaultDomainId()).toBe("a");
    });

    it("is empty when no domains are registered", () => {
      expect(getDefaultDomainId()).toBe("");
    });
  });
});

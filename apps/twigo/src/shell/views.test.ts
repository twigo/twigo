import { describe, it, expect, beforeEach } from "vitest";
import { Radio } from "lucide-react";
import {
  registerView,
  getViews,
  getView,
  getDefaultViewId,
  clearViews,
} from "./views";

describe("view registry", () => {
  beforeEach(() => clearViews());

  it("looks up views and lists them ordered by `order`", () => {
    registerView({ id: "b", title: "B", icon: Radio, order: 2 });
    registerView({ id: "a", title: "A", icon: Radio, order: 1 });
    expect(getViews().map((v) => v.id)).toEqual(["a", "b"]);
    expect(getView("a")?.title).toBe("A");
    expect(getView("missing")).toBeUndefined();
  });

  it("keeps registration order when `order` is equal", () => {
    registerView({ id: "x", title: "X", icon: Radio });
    registerView({ id: "y", title: "Y", icon: Radio });
    expect(getViews().map((v) => v.id)).toEqual(["x", "y"]);
  });

  it("replaces a view when its id is registered again", () => {
    registerView({ id: "a", title: "First", icon: Radio });
    registerView({ id: "a", title: "Second", icon: Radio });
    expect(getViews()).toHaveLength(1);
    expect(getView("a")?.title).toBe("Second");
  });

  describe("getDefaultViewId", () => {
    it("returns the opted-in default over registration order", () => {
      registerView({ id: "a", title: "A", icon: Radio });
      registerView({ id: "b", title: "B", icon: Radio, default: true });
      expect(getDefaultViewId()).toBe("b");
    });

    it("falls back to the first view when none is marked default", () => {
      registerView({ id: "a", title: "A", icon: Radio });
      registerView({ id: "b", title: "B", icon: Radio });
      expect(getDefaultViewId()).toBe("a");
    });

    it("is empty when no views are registered", () => {
      expect(getDefaultViewId()).toBe("");
    });
  });

  describe("domain filtering", () => {
    it("filters by domain, keeping untagged views in every domain", () => {
      registerView({ id: "n1", title: "N1", icon: Radio, domain: "nats" });
      registerView({
        id: "k1",
        title: "K1",
        icon: Radio,
        domain: "kubernetes",
      });
      registerView({ id: "any", title: "Any", icon: Radio });
      expect(getViews("nats").map((v) => v.id)).toEqual(["n1", "any"]);
      expect(getViews("kubernetes").map((v) => v.id)).toEqual(["k1", "any"]);
      expect(getViews().map((v) => v.id)).toEqual(["n1", "k1", "any"]);
    });

    it("resolves the default view within a domain", () => {
      registerView({ id: "n1", title: "N1", icon: Radio, domain: "nats" });
      registerView({
        id: "k1",
        title: "K1",
        icon: Radio,
        domain: "kubernetes",
        default: true,
      });
      registerView({
        id: "k2",
        title: "K2",
        icon: Radio,
        domain: "kubernetes",
      });
      expect(getDefaultViewId("nats")).toBe("n1");
      expect(getDefaultViewId("kubernetes")).toBe("k1");
    });
  });
});

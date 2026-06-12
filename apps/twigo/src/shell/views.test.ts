import { describe, it, expect, beforeEach } from "vitest";
import { Radio } from "lucide-react";
import { registerView, getViews, getView, clearViews } from "./views";

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
});

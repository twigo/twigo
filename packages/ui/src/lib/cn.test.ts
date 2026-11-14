import { describe, it, expect } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("lets later Tailwind classes win on conflict", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });

  it("drops falsy values", () => {
    expect(cn("a", null, undefined, "c")).toBe("a c");
  });

  it.each(["2xs", "label", "body", "prose", "title"])(
    "keeps the text-%s size beside a role",
    (step) => {
      expect(cn(`text-${step}`, "text-content")).toBe(
        `text-${step} text-content`,
      );
      expect(cn("text-content", `text-${step}`)).toBe(
        `text-content text-${step}`,
      );
    },
  );

  it("keeps the size when a role follows a run of classes", () => {
    expect(cn("min-w-0 text-body break-words text-content")).toBe(
      "min-w-0 text-body break-words text-content",
    );
  });

  it("lets the last of two sizes win", () => {
    expect(cn("text-label", "text-body")).toBe("text-body");
    expect(cn("text-body", "text-label")).toBe("text-label");
    expect(cn("text-xs", "text-prose")).toBe("text-prose");
    expect(cn("text-title", "text-sm")).toBe("text-sm");
    expect(cn("text-2xs", "text-title")).toBe("text-title");
  });

  it("lets the last of two roles win", () => {
    expect(cn("text-content", "text-support")).toBe("text-support");
  });
});

import { describe, it, expect } from "vitest";
import type { SubjectNode } from "@twigo/utils";
import { activeSubjects, navAction, type Row } from "./SubjectTree";

describe("activeSubjects", () => {
  const sessions = {
    s1: { connId: "a", subject: "orders.>" },
    s2: { connId: "a", subject: "audit.login" },
    s3: { connId: "b", subject: "orders.>" },
  };

  it("returns only the subjects streamed on the given connection", () => {
    expect(activeSubjects(sessions, "a").sort()).toEqual([
      "audit.login",
      "orders.>",
    ]);
  });

  it("is empty when the connection has no live streams", () => {
    expect(activeSubjects(sessions, "z")).toEqual([]);
    expect(activeSubjects({}, "a")).toEqual([]);
  });
});

describe("navAction", () => {
  const node = (path: string, children: SubjectNode[] = []): SubjectNode => ({
    token: path.split(".").pop() ?? path,
    path,
    count: 0,
    rate: 0,
    children,
  });
  const leaf = node("orders.created");
  const branch = node("orders", [leaf]);
  const rows: Row[] = [
    { node: branch, depth: 0 },
    { node: leaf, depth: 1 },
  ];
  const none = new Set<string>();

  it("moves within bounds", () => {
    expect(navAction("ArrowDown", rows, 0, none)).toEqual({
      kind: "move",
      to: 1,
    });
    expect(navAction("ArrowDown", rows, 1, none)).toEqual({
      kind: "move",
      to: 1,
    });
    expect(navAction("ArrowUp", rows, 0, none)).toEqual({
      kind: "move",
      to: 0,
    });
    expect(navAction("ArrowDown", [], 0, none)).toBeNull();
  });

  it("activates a branch as a wildcard and a leaf verbatim", () => {
    expect(navAction("Enter", rows, 0, none)).toEqual({
      kind: "activate",
      subject: "orders.>",
    });
    expect(navAction("Enter", rows, 1, none)).toEqual({
      kind: "activate",
      subject: "orders.created",
    });
  });

  it("folds branches with left/right, never leaves", () => {
    expect(navAction("ArrowLeft", rows, 0, none)).toEqual({
      kind: "toggle",
      path: "orders",
    });
    expect(navAction("ArrowRight", rows, 0, none)).toBeNull();
    expect(navAction("ArrowRight", rows, 0, new Set(["orders"]))).toEqual({
      kind: "toggle",
      path: "orders",
    });
    expect(navAction("ArrowLeft", rows, 1, none)).toBeNull();
  });
});

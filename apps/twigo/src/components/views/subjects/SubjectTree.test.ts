import { describe, it, expect } from "vitest";
import { activeSubjects } from "./SubjectTree";

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

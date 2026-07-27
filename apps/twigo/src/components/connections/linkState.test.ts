import { describe, it, expect } from "vitest";
import { linkState } from "./linkState";
import type { ConnInfo } from "@/lib/api";

const live: ConnInfo = {
  name: "a",
  server: {
    serverName: "s",
    serverVersion: "2.14.2",
    jetstream: true,
    maxPayload: 0,
  },
};
const dropped: ConnInfo = { name: "a", server: null };

describe("linkState", () => {
  it("dialling wins over everything, including a stale entry", () => {
    expect(linkState(live, true, false)).toBe("dialling");
    expect(linkState(undefined, true, true)).toBe("dialling");
  });

  it("is live only once the server has answered", () => {
    expect(linkState(live, false, false)).toBe("live");
  });

  it("separates a dropped link from never having connected", () => {
    expect(linkState(dropped, false, false)).toBe("reconnecting");
    expect(linkState(undefined, false, false)).toBe("offline");
  });

  it("reports a failure only when there is no connection to speak of", () => {
    expect(linkState(undefined, false, true)).toBe("failed");
    // An existing entry means the link is coming back, whatever the last error.
    expect(linkState(dropped, false, true)).toBe("reconnecting");
  });
});

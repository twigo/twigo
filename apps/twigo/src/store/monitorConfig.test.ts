import { describe, it, expect, beforeEach } from "vitest";
import { useMonitorConfig } from "./monitorConfig";

describe("monitorConfig store", () => {
  beforeEach(() => {
    useMonitorConfig.setState({ urls: {} });
  });

  it("stores a trimmed URL per connection", () => {
    useMonitorConfig.getState().setUrl("local", "  http://127.0.0.1:8222  ");
    expect(useMonitorConfig.getState().urls).toEqual({
      local: "http://127.0.0.1:8222",
    });
  });

  it("keeps connections independent", () => {
    const { setUrl } = useMonitorConfig.getState();
    setUrl("a", "http://a:8222");
    setUrl("b", "http://b:8222");
    expect(useMonitorConfig.getState().urls).toEqual({
      a: "http://a:8222",
      b: "http://b:8222",
    });
  });

  it("removes the entry when cleared with null or blank", () => {
    const { setUrl } = useMonitorConfig.getState();
    setUrl("a", "http://a:8222");
    setUrl("a", null);
    expect(useMonitorConfig.getState().urls).not.toHaveProperty("a");

    setUrl("a", "http://a:8222");
    setUrl("a", "   ");
    expect(useMonitorConfig.getState().urls).not.toHaveProperty("a");
  });
});

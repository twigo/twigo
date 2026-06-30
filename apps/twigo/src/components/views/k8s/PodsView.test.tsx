import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PodsView } from "./PodsView";

describe("PodsView", () => {
  afterEach(cleanup);

  it("lists the mock pods", () => {
    render(<PodsView filter="" connId={null} />);
    expect(screen.getByText("api-7d9f8c-2xk4l")).toBeInTheDocument();
    expect(screen.getByText("billing-84cd-rt9xv")).toBeInTheDocument();
  });

  it("filters by name", () => {
    render(<PodsView filter="billing" connId={null} />);
    expect(screen.getByText("billing-84cd-rt9xv")).toBeInTheDocument();
    expect(screen.queryByText("api-7d9f8c-2xk4l")).not.toBeInTheDocument();
  });

  it("shows an empty state when nothing matches", () => {
    render(<PodsView filter="zzz-nomatch" connId={null} />);
    expect(screen.getByText(/No pods match/i)).toBeInTheDocument();
  });
});

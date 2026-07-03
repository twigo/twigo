import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PanelBoundary } from "./PanelBoundary";
import { useToasts } from "@/store/toasts";

function Bomb({ armed }: { armed: boolean }) {
  if (armed) throw new Error("panel exploded");
  return <div>panel content</div>;
}

afterEach(cleanup);

describe("PanelBoundary", () => {
  beforeEach(() => {
    useToasts.setState({ toasts: [] });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("contains a crash to the panel and reports a toast", () => {
    render(
      <PanelBoundary label="Streams">
        <Bomb armed />
      </PanelBoundary>,
    );
    expect(screen.getByText("Streams crashed.")).toBeVisible();
    expect(screen.getByText("panel exploded")).toBeVisible();
    expect(useToasts.getState().toasts[0]?.message).toContain("panel exploded");
  });

  it("recovers via Try again once the cause is gone", () => {
    const { rerender } = render(
      <PanelBoundary label="Streams">
        <Bomb armed />
      </PanelBoundary>,
    );
    rerender(
      <PanelBoundary label="Streams">
        <Bomb armed={false} />
      </PanelBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("panel content")).toBeVisible();
  });
});

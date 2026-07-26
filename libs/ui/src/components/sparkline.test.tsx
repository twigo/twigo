import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Sparkline } from "./sparkline";

const PROPS = { windowMs: 1000, gapMs: 500, label: "Throughput, last 15m" };

describe("Sparkline", () => {
  afterEach(cleanup);

  it("draws a labelled chart from the points", () => {
    render(
      <Sparkline
        {...PROPS}
        points={[
          { t: 0, v: 1 },
          { t: 1000, v: 2 },
        ]}
      />,
    );
    const chart = screen.getByRole("img", { name: PROPS.label });
    expect(chart.querySelectorAll("path")).toHaveLength(2);
  });

  it("holds the row height without announcing an empty chart", () => {
    const { container } = render(<Sparkline {...PROPS} points={[]} />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});

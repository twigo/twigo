import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RawConfigDialog } from "./RawConfigDialog";

describe("RawConfigDialog", () => {
  afterEach(cleanup);

  const open = (
    fetchCurrent: () => Promise<Record<string, unknown>>,
    onApply = vi.fn(),
  ) => {
    render(
      <RawConfigDialog
        stream="ORDERS"
        config={{ name: "ORDERS", max_msgs: 10 }}
        fetchCurrent={fetchCurrent}
        onClose={vi.fn()}
        onApply={onApply}
      />,
    );
    return onApply;
  };

  it("reviews against the server's current config, not the opened snapshot", async () => {
    // The stream gained a republish block while the dialog sat open.
    open(() =>
      Promise.resolve({
        name: "ORDERS",
        max_msgs: 10,
        republish: { src: ">", dest: "mirror.>" },
      }),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );

    expect(await screen.findByText("republish")).toBeInTheDocument();
    expect(screen.getByText("removed")).toBeInTheDocument();
  });

  it("refuses to review when the current config cannot be read", async () => {
    open(() => Promise.reject(new Error("stream not found")));

    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );

    expect(
      await screen.findByText(/Could not re-read the current config/),
    ).toBeInTheDocument();
  });

  it("reports no changes when the server still matches the text", async () => {
    open(() => Promise.resolve({ name: "ORDERS", max_msgs: 10 }));

    await userEvent.click(
      screen.getByRole("button", { name: "Review changes" }),
    );

    expect(await screen.findByText("No changes.")).toBeInTheDocument();
  });
});

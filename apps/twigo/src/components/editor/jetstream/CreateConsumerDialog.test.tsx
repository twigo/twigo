import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CreateConsumerDialog } from "./CreateConsumerDialog";

afterEach(cleanup);

describe("CreateConsumerDialog", () => {
  it("builds a durable pull consumer config", () => {
    const onCreate = vi.fn();
    render(
      <CreateConsumerDialog
        stream="ORDERS"
        onClose={() => undefined}
        onCreate={onCreate}
      />,
    );

    const create = screen.getByRole("button", { name: "Create consumer" });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("worker"), {
      target: { value: "worker" },
    });
    fireEvent.change(screen.getByPlaceholderText("orders.>"), {
      target: { value: "orders.>" },
    });
    expect(create).not.toBeDisabled();

    fireEvent.click(create);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      durable_name: "worker",
      name: "worker",
      ack_policy: "explicit",
      deliver_policy: "all",
      filter_subject: "orders.>",
    });
  });
});

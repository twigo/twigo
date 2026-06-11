import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CreateStreamDialog } from "./CreateStreamDialog";

afterEach(cleanup);

describe("CreateStreamDialog", () => {
  it("requires a name and subjects, then builds a wire config", () => {
    const onCreate = vi.fn();
    render(
      <CreateStreamDialog onClose={() => undefined} onCreate={onCreate} />,
    );

    const create = screen.getByRole("button", { name: "Create stream" });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("ORDERS"), {
      target: { value: "ORDERS" },
    });
    fireEvent.change(screen.getByPlaceholderText("orders.>"), {
      target: { value: "orders.>, orders.dlq" },
    });
    expect(create).not.toBeDisabled();

    fireEvent.click(create);
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      name: "ORDERS",
      subjects: ["orders.>", "orders.dlq"],
      storage: "file",
      retention: "limits",
      max_msgs: -1,
      max_age: 0,
      num_replicas: 1,
    });
  });
});

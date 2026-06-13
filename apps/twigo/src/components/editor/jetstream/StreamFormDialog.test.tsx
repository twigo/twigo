import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { StreamFormDialog } from "./StreamFormDialog";

afterEach(cleanup);

describe("StreamFormDialog", () => {
  it("requires a name and subjects, then builds a wire config", () => {
    const onSubmit = vi.fn();
    render(
      <StreamFormDialog
        title="New stream"
        submitLabel="Create stream"
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

    const create = screen.getByRole("button", { name: "Create stream" });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("ORDERS"), {
      target: { value: "ORDERS" },
    });
    fireEvent.change(screen.getByPlaceholderText("orders.>, audit.*"), {
      target: { value: "orders.>, orders.dlq" },
    });
    expect(create).not.toBeDisabled();

    fireEvent.click(create);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: "ORDERS",
      subjects: ["orders.>", "orders.dlq"],
      storage: "file",
      retention: "limits",
      max_msgs: -1,
      max_age: 0,
      num_replicas: 1,
    });
  });

  it("locks identity fields in edit mode and prefills", () => {
    render(
      <StreamFormDialog
        title="Edit ORDERS"
        submitLabel="Save"
        lockIdentity
        initial={{
          name: "ORDERS",
          subjects: "orders.>",
          storage: "file",
          retention: "limits",
          discard: "old",
          maxMsgs: "-1",
          maxBytes: "-1",
          maxAgeSec: "0",
          replicas: "1",
        }}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    const name = screen.getByDisplayValue("ORDERS");
    expect(name).toBeDisabled();
    expect(screen.getAllByText("Immutable after creation.")).toHaveLength(3);
  });
});

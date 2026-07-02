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

  const editProps = {
    title: "Edit ORDERS",
    submitLabel: "Save",
    lockIdentity: true,
    initial: {
      name: "ORDERS",
      subjects: "orders.>",
      storage: "file",
      retention: "limits",
      discard: "old",
      maxMsgs: "-1",
      maxBytes: "-1",
      maxAgeSec: "0",
      replicas: "1",
    },
  };

  it("disables submit in edit mode until something actually changes", () => {
    render(
      <StreamFormDialog
        {...editProps}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    const review = screen.getByRole("button", { name: "Review changes" });
    expect(review).toBeDisabled();

    const maxMsgs = screen.getAllByDisplayValue("-1")[0]!;
    fireEvent.change(maxMsgs, { target: { value: "500" } });
    expect(review).not.toBeDisabled();

    fireEvent.change(maxMsgs, { target: { value: "-1" } });
    expect(review).toBeDisabled();
  });

  it("reviews the diff before applying an edit, with a way back", () => {
    const onSubmit = vi.fn();
    render(
      <StreamFormDialog
        {...editProps}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getAllByDisplayValue("-1")[0]!, {
      target: { value: "500" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));

    expect(screen.getByText("max_msgs")).toBeInTheDocument();
    expect(screen.getByText("unlimited")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByDisplayValue("500")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      name: "ORDERS",
      max_msgs: 500,
    });
  });
});

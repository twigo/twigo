import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CreateObjBucketDialog } from "./CreateObjBucketDialog";

afterEach(cleanup);

describe("CreateObjBucketDialog", () => {
  it("requires a name and builds a wire config", () => {
    const onCreate = vi.fn();
    render(
      <CreateObjBucketDialog onClose={() => undefined} onCreate={onCreate} />,
    );

    const create = screen.getByRole("button", { name: "Create store" });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("assets"), {
      target: { value: "backups" },
    });
    expect(create).not.toBeDisabled();

    fireEvent.click(create);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      bucket: "backups",
      maxAge: 0,
      storage: "file",
      numReplicas: 1,
    });
  });
});

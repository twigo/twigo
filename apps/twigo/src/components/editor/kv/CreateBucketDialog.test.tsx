import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CreateBucketDialog } from "./CreateBucketDialog";

afterEach(cleanup);

describe("CreateBucketDialog", () => {
  it("requires a name and builds a wire config", () => {
    const onCreate = vi.fn();
    render(
      <CreateBucketDialog onClose={() => undefined} onCreate={onCreate} />,
    );

    const create = screen.getByRole("button", { name: "Create bucket" });
    expect(create).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("config"), {
      target: { value: "sessions" },
    });
    expect(create).not.toBeDisabled();

    fireEvent.click(create);
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      bucket: "sessions",
      history: 1,
      maxAge: 0,
      storage: "file",
      numReplicas: 1,
    });
  });
});

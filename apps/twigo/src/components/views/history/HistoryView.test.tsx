import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const { openPublish } = vi.hoisted(() => ({ openPublish: vi.fn() }));
vi.mock("@/lib/editor", () => ({ openPublish }));

import { HistoryView } from "./HistoryView";
import { useHistory } from "@/store/history";

afterEach(cleanup);

describe("HistoryView", () => {
  beforeEach(() => {
    openPublish.mockClear();
    useHistory.setState({ entries: [], nextId: 1 });
    useHistory.getState().record({
      connId: "prod",
      kind: "publish",
      subject: "orders.created",
      payloadB64: btoa('{"id":1}'),
      headers: [["k", "v"]],
    });
  });

  it("lists entries for the connection and replays into a publish tab", () => {
    render(<HistoryView filter="" connId="prod" />);
    fireEvent.click(screen.getByText("orders.created"));
    expect(openPublish).toHaveBeenCalledWith(
      "prod",
      "orders.created",
      '{"id":1}',
      [["k", "v"]],
    );
  });

  it("filters by subject and scopes to the connection", () => {
    render(<HistoryView filter="audit" connId="prod" />);
    expect(screen.queryByText("orders.created")).not.toBeInTheDocument();

    cleanup();
    render(<HistoryView filter="" connId="other" />);
    expect(screen.queryByText("orders.created")).not.toBeInTheDocument();
  });
});

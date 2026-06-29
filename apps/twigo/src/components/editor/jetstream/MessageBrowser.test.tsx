import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  openPublish: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ jsGetMessages: mocks.getMessages }));
vi.mock("@/lib/editor", () => ({ openPublish: mocks.openPublish }));
vi.mock("@twigo/ui", async () => {
  const actual = await vi.importActual<typeof import("@twigo/ui")>("@twigo/ui");
  return {
    ...actual,
    CodeViewer: ({ value }: { value: string }) => (
      <pre data-testid="payload">{value}</pre>
    ),
  };
});

import { MessageBrowser, nextSelectionAfterDelete } from "./MessageBrowser";

function msg(seq: number, body: string) {
  return {
    seq,
    subject: "orders.created",
    time: null,
    size: body.length,
    payloadB64: btoa(body),
    headers: [] as [string, string][],
    truncated: false,
  };
}

describe("MessageBrowser", () => {
  beforeEach(() => {
    mocks.getMessages.mockReset();
    mocks.openPublish.mockReset();
  });
  afterEach(cleanup);

  it("loads newest-first on expand and previews the selected payload", async () => {
    mocks.getMessages.mockResolvedValue({
      messages: [msg(2, '{"id":2}'), msg(1, '{"id":1}')],
      nextSeq: null,
    });

    render(<MessageBrowser connId="dev" stream="ORDERS" />);
    fireEvent.click(screen.getByText("Messages"));

    expect(await screen.findByText("#2")).toBeInTheDocument();
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(mocks.getMessages).toHaveBeenCalledWith(
      "dev",
      "ORDERS",
      null,
      25,
      true,
    );

    // First (newest) message is auto-selected and pretty-printed.
    expect(screen.getByTestId("payload").textContent).toContain('"id": 2');
  });

  it("republishes the selected message into a publish tab", async () => {
    mocks.getMessages.mockResolvedValue({
      messages: [msg(2, '{"id":2}')],
      nextSeq: null,
    });
    render(<MessageBrowser connId="dev" stream="ORDERS" />);
    fireEvent.click(screen.getByText("Messages"));
    await screen.findByText("#2");

    fireEvent.click(screen.getByLabelText("Republish"));
    expect(mocks.openPublish).toHaveBeenCalledWith(
      "dev",
      "orders.created",
      '{"id":2}',
      [],
    );
  });
});

describe("nextSelectionAfterDelete", () => {
  // The filtered view the user sees (newest first); seqs 4/2 are hidden.
  const shown = [{ seq: 5 }, { seq: 3 }, { seq: 1 }];

  it("selects the row that slides into the deleted slot", () => {
    expect(nextSelectionAfterDelete(shown, 3)).toBe(1);
  });

  it("falls back to the previous row when deleting the last visible row", () => {
    expect(nextSelectionAfterDelete(shown, 1)).toBe(3);
  });

  it("returns null when the filtered view becomes empty", () => {
    expect(nextSelectionAfterDelete([{ seq: 7 }], 7)).toBe(null);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { StreamMessage } from "@twigo/utils";

vi.mock("@/lib/editor", () => ({ openPublish: vi.fn() }));
vi.mock("@twigo/ui", async () => {
  const actual = await vi.importActual<typeof import("@twigo/ui")>("@twigo/ui");
  return {
    ...actual,
    CodeViewer: ({ value }: { value: string }) => (
      <pre data-testid="payload">{value}</pre>
    ),
  };
});

import { DetailPanel } from "./DetailPanel";
import { useStream } from "@/store/stream";
import { useCompare } from "@/store/compare";

const STREAM = "stream-1";

function message(id: number): StreamMessage {
  const body = JSON.stringify({ id });
  return {
    id,
    receivedAt: 1_700_000_000_000,
    subject: "orders.created",
    reply: null,
    payloadB64: btoa(body),
    headers: [["Nats-Msg-Id", "abc"]],
    size: body.length,
    preview: body,
  };
}

function seed(
  selectedId: number | null,
  items: StreamMessage[] = [message(1)],
) {
  useStream.setState({
    sessions: {
      [STREAM]: {
        id: STREAM,
        connId: "conn-1",
        subject: "orders.>",
        subId: "sub-1",
        items,
        paused: false,
        following: true,
        selectedId,
        received: items.length,
        dropped: 0,
      },
    },
    activeId: STREAM,
  });
}

describe("DetailPanel", () => {
  beforeEach(() => {
    useCompare.setState({ pinned: null });
    seed(null);
  });
  afterEach(cleanup);

  it("prompts to select when nothing is selected", () => {
    render(<DetailPanel streamId={STREAM} />);
    expect(screen.getByText(/select a message to inspect/i)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /copy payload/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the selected message and its actions", () => {
    seed(1);
    render(<DetailPanel streamId={STREAM} />);
    expect(screen.getByText("orders.created")).toBeVisible();
    expect(screen.getByText("Nats-Msg-Id")).toBeVisible();
    expect(screen.getByTestId("payload")).toHaveTextContent('"id": 1');
    expect(
      screen.getByRole("button", { name: /copy payload/i }),
    ).toBeInTheDocument();
  });

  it("deselects the message when the inspector is closed", () => {
    seed(1);
    render(<DetailPanel streamId={STREAM} />);
    fireEvent.click(screen.getByRole("button", { name: /close inspector/i }));
    expect(useStream.getState().sessions[STREAM]?.selectedId).toBeNull();
  });
});

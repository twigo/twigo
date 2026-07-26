import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  getMessages: vi.fn(),
  deleteMessage: vi.fn(),
  createConsumer: vi.fn(),
  openPublish: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  jsGetMessages: mocks.getMessages,
  jsDeleteMessage: mocks.deleteMessage,
  jsCreateConsumer: mocks.createConsumer,
}));
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

import {
  StreamBrowsePanel,
  nextSelectionAfterDelete,
} from "./StreamBrowsePanel";

// jsdom has no layout; the virtualizer reads offsetWidth/offsetHeight.
const original = {
  offsetHeight: Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetHeight",
  ),
  offsetWidth: Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetWidth",
  ),
};
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
});
afterAll(() => {
  for (const [key, desc] of Object.entries(original)) {
    if (desc) Object.defineProperty(HTMLElement.prototype, key, desc);
  }
});

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

describe("StreamBrowsePanel", () => {
  beforeEach(() => {
    mocks.getMessages.mockReset();
    mocks.openPublish.mockReset();
  });
  afterEach(cleanup);

  it("loads the newest page on open and inspects the first message", async () => {
    mocks.getMessages.mockResolvedValue({
      messages: [msg(2, '{"id":2}'), msg(1, '{"id":1}')],
      nextSeq: null,
    });

    render(<StreamBrowsePanel connId="dev" stream="ORDERS" />);

    expect(await screen.findAllByRole("row")).toHaveLength(3); // header + 2
    expect(mocks.getMessages).toHaveBeenCalledWith(
      "dev",
      "ORDERS",
      null,
      50,
      true,
    );
    // Newest is auto-selected, and the inspector - not a panel below - shows it.
    expect(screen.getByTestId("payload").textContent).toContain('"id": 2');
  });

  it("shows a dash instead of 1970 for a message with no stored timestamp", async () => {
    mocks.getMessages.mockResolvedValue({
      messages: [msg(2, "{}")],
      nextSeq: null,
    });

    render(<StreamBrowsePanel connId="dev" stream="ORDERS" />);
    await screen.findAllByRole("row");

    expect(screen.getByText("-")).toBeInTheDocument();
  });

  it("republishes the selected message into a publish tab", async () => {
    mocks.getMessages.mockResolvedValue({
      messages: [msg(2, '{"id":2}')],
      nextSeq: null,
    });

    render(<StreamBrowsePanel connId="dev" stream="ORDERS" />);
    await screen.findAllByRole("row");

    fireEvent.click(screen.getByLabelText("Republish"));
    expect(mocks.openPublish).toHaveBeenCalledWith(
      "dev",
      "orders.created",
      "",
      [],
      btoa('{"id":2}'),
    );
  });

  it("filters the loaded rows without refetching", async () => {
    mocks.getMessages.mockResolvedValue({
      messages: [msg(2, '{"id":2}'), msg(1, '{"id":1}')],
      nextSeq: null,
    });

    render(<StreamBrowsePanel connId="dev" stream="ORDERS" />);
    await screen.findAllByRole("row");

    fireEvent.change(screen.getByLabelText("Filter messages"), {
      target: { value: '"id":1' },
    });

    expect(screen.getAllByRole("row")).toHaveLength(2); // header + 1
    expect(mocks.getMessages).toHaveBeenCalledTimes(1);
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

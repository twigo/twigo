import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { StreamMessage } from "@twigo/utils";
import { MessageTable } from "./MessageTable";

afterEach(cleanup);

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

function msg(id: number): StreamMessage {
  return {
    id,
    receivedAt: 1700000000000 + id,
    subject: `orders.${id.toString()}`,
    reply: null,
    payloadB64: "",
    headers: [],
    size: 42,
    preview: `payload ${id.toString()}`,
  };
}

function Harness({
  items,
  selectedId = null,
  onSelect = () => undefined,
}: {
  items: StreamMessage[];
  selectedId?: number | null;
  onSelect?: (id: number) => void;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setEl} style={{ height: 600, overflow: "auto" }}>
      <MessageTable
        items={items}
        selectedId={selectedId}
        onSelect={onSelect}
        scrollEl={el}
      />
    </div>
  );
}

describe("MessageTable", () => {
  it("renders header and visible rows", () => {
    render(<Harness items={[msg(1), msg(2)]} />);
    expect(
      screen.getByRole("columnheader", { name: "Subject" }),
    ).toBeInTheDocument();
    expect(screen.getByText("orders.1")).toBeInTheDocument();
    expect(screen.getByText("payload 2")).toBeInTheDocument();
  });

  it("virtualizes: far-offscreen rows are not in the DOM", () => {
    const items = Array.from({ length: 2000 }, (_, i) => msg(i + 1));
    render(<Harness items={items} />);
    expect(screen.getByText("orders.1")).toBeInTheDocument();
    expect(screen.queryByText("orders.1999")).not.toBeInTheDocument();
    // 600px viewport / 24px rows + overscan — far below the 2000 total.
    expect(screen.getAllByRole("row").length).toBeLessThan(100);
  });

  it("selects on click and marks the selected row", () => {
    const onSelect = vi.fn();
    render(
      <Harness items={[msg(1), msg(2)]} selectedId={2} onSelect={onSelect} />,
    );
    fireEvent.click(screen.getByText("orders.1"));
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.getByText("orders.2").closest('[role="row"]')).toHaveClass(
      "bg-selected",
    );
  });

  it("selects with the keyboard", () => {
    const onSelect = vi.fn();
    render(<Harness items={[msg(7)]} onSelect={onSelect} />);
    const row = screen.getByText("orders.7").closest('[role="row"]');
    fireEvent.keyDown(row as HTMLElement, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(7);
  });
});

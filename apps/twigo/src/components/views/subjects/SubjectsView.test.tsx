import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

vi.mock("@/lib/editor", () => ({
  openStream: vi.fn(),
  openPublish: vi.fn(),
  openResponder: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  startSubjectWatch: vi.fn(),
  stopSubjectWatch: vi.fn(),
}));

import { SubjectsView } from "./SubjectsView";
import { useSubjects } from "@/store/subjects";
import { useConnections } from "@/store/connections";

const CONN = "c1";

function rowOrder(): string[] {
  return screen
    .getAllByRole("treeitem")
    .map((li) => /^[a-z]+/.exec(li.textContent)?.[0] ?? "");
}

describe("SubjectsView sorting", () => {
  beforeEach(() => {
    useConnections.setState({
      connected: {
        [CONN]: {
          name: CONN,
          serverName: "s",
          serverVersion: "2.14.2",
          rttMs: 0,
          jetstream: false,
          maxPayload: 0,
          connected: true,
        },
      },
    });
    useSubjects.setState({
      sort: "name",
      watching: { [CONN]: ">" },
      byConn: {
        [CONN]: {
          truncated: false,
          stats: [
            { subject: "alpha", count: 5, rate: 1 },
            { subject: "bravo", count: 900, rate: 0 },
            { subject: "charlie", count: 1, rate: 40 },
          ],
        },
      },
    });
  });
  afterEach(() => {
    cleanup();
    useSubjects.setState({ sort: "name", watching: {}, byConn: {} });
  });

  it("lists alphabetically by default", () => {
    render(<SubjectsView filter="" connId={CONN} />);
    expect(rowOrder()).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("puts the busiest subject first when sorting by rate", async () => {
    render(<SubjectsView filter="" connId={CONN} />);
    await userEvent.click(screen.getByRole("radio", { name: "rate" }));
    expect(rowOrder()).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("ranks by messages seen, not by current rate", async () => {
    render(<SubjectsView filter="" connId={CONN} />);
    await userEvent.click(screen.getByRole("radio", { name: "msgs" }));
    expect(rowOrder()).toEqual(["bravo", "alpha", "charlie"]);
  });

  it("keeps the chosen sort across remounts", async () => {
    const { unmount } = render(<SubjectsView filter="" connId={CONN} />);
    await userEvent.click(screen.getByRole("radio", { name: "rate" }));
    unmount();

    render(<SubjectsView filter="" connId={CONN} />);
    expect(rowOrder()).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("shows the message count next to the rate", () => {
    render(<SubjectsView filter="" connId={CONN} />);
    expect(screen.getByText("900")).toBeInTheDocument();
  });

  it("keeps a subject slower than 0.1/s distinguishable from a silent one", () => {
    act(() => {
      useSubjects.setState({
        byConn: {
          [CONN]: {
            truncated: false,
            stats: [
              { subject: "trickle", count: 2, rate: 0.02 },
              { subject: "silent", count: 7, rate: 0 },
            ],
          },
        },
      });
    });
    render(<SubjectsView filter="" connId={CONN} />);
    expect(screen.getByText("<0.1/s")).toBeInTheDocument();
    expect(screen.getByText("0/s")).toBeInTheDocument();
  });
});

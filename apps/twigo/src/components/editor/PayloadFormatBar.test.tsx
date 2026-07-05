import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  codecDecode: vi.fn(),
  codecEncode: vi.fn(),
}));

import { PayloadFormatBar } from "./PayloadFormatBar";
import { useCodecs } from "@/store/codecs";
import type { DecodeTarget } from "@/lib/codecs";

afterEach(cleanup);

function renderBar(value: DecodeTarget, subject = "orders.created") {
  return render(
    <PayloadFormatBar
      value={value}
      onChange={() => undefined}
      connId="c"
      subject={subject}
    />,
  );
}

describe("PayloadFormatBar mapping pin", () => {
  beforeEach(() => {
    useCodecs.setState({ schemas: [], mappings: {} });
  });

  it("hides the pin for a builtin target with no mapping", () => {
    renderBar({ kind: "builtin", format: "json" });
    expect(
      screen.queryByRole("button", { name: /Remember codec|Mapped via/ }),
    ).not.toBeInTheDocument();
  });

  it("saves a mapping prefilled with the current subject", () => {
    renderBar({ kind: "codec", codec: "msgpack" });
    fireEvent.click(
      screen.getByRole("button", { name: "Remember codec for this subject" }),
    );
    expect(screen.getByLabelText("Subject pattern")).toHaveValue(
      "orders.created",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));
    expect(useCodecs.getState().mappings.c).toMatchObject([
      { pattern: "orders.created", codec: "msgpack" },
    ]);
  });

  it("updates the existing mapping instead of adding a duplicate", () => {
    useCodecs
      .getState()
      .addMapping("c", { pattern: "orders.>", codec: "cbor" });
    renderBar({ kind: "codec", codec: "msgpack" });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Mapped via orders.> - update or remove",
      }),
    );
    expect(screen.getByLabelText("Subject pattern")).toHaveValue("orders.>");
    fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));
    expect(useCodecs.getState().mappings.c).toMatchObject([
      { pattern: "orders.>", codec: "msgpack" },
    ]);
  });

  it("disables save for an invalid pattern", () => {
    renderBar({ kind: "codec", codec: "cbor" });
    fireEvent.click(
      screen.getByRole("button", { name: "Remember codec for this subject" }),
    );
    fireEvent.change(screen.getByLabelText("Subject pattern"), {
      target: { value: "a..b" },
    });
    expect(screen.getByRole("button", { name: "Save mapping" })).toBeDisabled();
  });

  it("warns when the pattern does not match the subject", () => {
    renderBar({ kind: "codec", codec: "cbor" });
    fireEvent.click(
      screen.getByRole("button", { name: "Remember codec for this subject" }),
    );
    fireEvent.change(screen.getByLabelText("Subject pattern"), {
      target: { value: "audit.>" },
    });
    expect(screen.getByText(/does not match/)).toBeInTheDocument();
  });

  it("removes the mapping from the pinned state", () => {
    useCodecs
      .getState()
      .addMapping("c", { pattern: "orders.>", codec: "cbor" });
    renderBar({ kind: "codec", codec: "cbor" });
    fireEvent.click(
      screen.getByRole("button", { name: "Mapped via orders.>" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(useCodecs.getState().mappings.c).toHaveLength(0);
  });

  it("offers removal when a mapping exists but a builtin format is shown", () => {
    useCodecs
      .getState()
      .addMapping("c", { pattern: "orders.>", codec: "cbor" });
    renderBar({ kind: "builtin", format: "json" });
    fireEvent.click(
      screen.getByRole("button", { name: /Mapped via orders\.>/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove mapping" }));
    expect(useCodecs.getState().mappings.c).toHaveLength(0);
  });
});

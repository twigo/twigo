import { describe, it, expect, beforeEach, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

vi.mock("@/lib/api", () => ({
  codecImportProtos: vi.fn(() => Promise.resolve(null)),
  syncConnReadonly: vi.fn(() => Promise.resolve()),
}));

import { SchemasSection } from "./SchemasSection";
import { useCodecs } from "@/store/codecs";
import { useConnections } from "@/store/connections";

afterEach(cleanup);

describe("SchemasSection", () => {
  beforeEach(() => {
    useCodecs.setState({ schemas: [], mappings: {} });
    useConnections.setState({ activeContext: "prod" });
  });

  it("renders with zero mappings without an update loop (StrictMode)", () => {
    render(
      <StrictMode>
        <SchemasSection />
      </StrictMode>,
    );
    expect(screen.getByText(/Mappings for/)).toBeInTheDocument();
  });

  it("lists mappings for the active connection", () => {
    useCodecs.getState().addMapping("prod", {
      pattern: "orders.>",
      codec: "cbor",
    });
    render(
      <StrictMode>
        <SchemasSection />
      </StrictMode>,
    );
    expect(screen.getByText("orders.>")).toBeInTheDocument();
    expect(screen.getByText("CBOR")).toBeInTheDocument();
  });
});

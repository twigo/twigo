import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Radio, Boxes } from "lucide-react";
import { registerDomain, clearDomains } from "@/shell/domains";
import { useUi } from "@/store/ui";
import { DomainSwitcher } from "./DomainSwitcher";

describe("DomainSwitcher", () => {
  beforeEach(() => {
    clearDomains();
    useUi.setState({ activeDomain: "", activeView: "" });
  });
  afterEach(cleanup);

  it("renders a control per registered domain", () => {
    registerDomain({ id: "nats", title: "NATS", icon: Radio, default: true });
    registerDomain({ id: "kubernetes", title: "Kubernetes", icon: Boxes });
    render(<DomainSwitcher />);
    expect(screen.getByLabelText("NATS")).toBeInTheDocument();
    expect(screen.getByLabelText("Kubernetes")).toBeInTheDocument();
  });

  it("hides itself until a second domain exists", () => {
    registerDomain({ id: "nats", title: "NATS", icon: Radio, default: true });
    const { container } = render(<DomainSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });
});

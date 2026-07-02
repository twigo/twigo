import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Radio, Boxes } from "lucide-react";
import { registerDomain, clearDomains } from "@/shell/domains";
import { useSpaces } from "@/store/spaces";
import { useUi } from "@/store/ui";
import { SpaceTabs } from "./SpaceTabs";

describe("SpaceTabs", () => {
  beforeEach(() => {
    clearDomains();
    useSpaces.setState({
      spaces: [{ id: "space-nats", domainId: "nats" }],
      activeId: "space-nats",
      lastView: {},
    });
    useUi.setState({ activeView: "" });
  });
  afterEach(cleanup);

  it("renders nothing outside Tauri while only one domain is registered", () => {
    registerDomain({ id: "nats", title: "NATS", icon: Radio, default: true });
    const { container } = render(<SpaceTabs />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows tabs and the new-space button once a second domain registers", () => {
    registerDomain({ id: "nats", title: "NATS", icon: Radio, default: true });
    registerDomain({ id: "kubernetes", title: "Kubernetes", icon: Boxes });
    render(<SpaceTabs />);
    expect(screen.getByText("NATS")).toBeInTheDocument();
    expect(screen.getByLabelText("New space")).toBeInTheDocument();
  });

  it("labels a target-pinned space as 'Technology · target' and switches on click", () => {
    registerDomain({ id: "nats", title: "NATS", icon: Radio, default: true });
    registerDomain({ id: "kubernetes", title: "Kubernetes", icon: Boxes });
    useSpaces.setState({
      spaces: [
        { id: "space-nats", domainId: "nats" },
        {
          id: "space-k8s",
          domainId: "kubernetes",
          targetId: "minikube",
          targetLabel: "minikube",
        },
      ],
    });
    render(<SpaceTabs />);
    const k8sTab = screen.getByText("Kubernetes · minikube");
    fireEvent.click(k8sTab);
    expect(useSpaces.getState().activeId).toBe("space-k8s");
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Radio, Boxes } from "lucide-react";
import { registerDomain, clearDomains } from "@/shell/domains";
import { useUi } from "@/store/ui";
import { useSpaces } from "./spaces";

function resetSpaces() {
  useSpaces.setState({
    spaces: [{ id: "space-nats", domainId: "nats" }],
    activeId: "space-nats",
    lastView: {},
  });
  useUi.setState({ activeView: "" });
}

describe("spaces store", () => {
  beforeEach(() => {
    clearDomains();
    registerDomain({ id: "nats", title: "NATS", icon: Radio, default: true });
    resetSpaces();
  });

  it("parks the view on switch and restores it on return", () => {
    useUi.getState().setView("jetstream");
    useSpaces.getState().addSpace("kubernetes");
    // New space starts on its default (empty resolves at read time).
    expect(useUi.getState().activeView).toBe("");
    useUi.getState().setView("k8s.pods");

    useSpaces.getState().setActive("space-nats");
    expect(useUi.getState().activeView).toBe("jetstream");

    const k8sSpace = useSpaces.getState().spaces[1]!;
    useSpaces.getState().setActive(k8sSpace.id);
    expect(useUi.getState().activeView).toBe("k8s.pods");
  });

  it("re-activates a pinned target through the domain hook on focus", () => {
    const activateTarget = vi.fn();
    registerDomain({
      id: "kubernetes",
      title: "Kubernetes",
      icon: Boxes,
      activateTarget,
    });
    useSpaces
      .getState()
      .addSpace("kubernetes", { id: "minikube", label: "minikube" });
    expect(activateTarget).toHaveBeenCalledWith("minikube");

    useSpaces.getState().setActive("space-nats");
    const pinned = useSpaces.getState().spaces[1]!;
    useSpaces.getState().setActive(pinned.id);
    expect(activateTarget).toHaveBeenCalledTimes(2);
  });

  it("never closes the last space", () => {
    useSpaces.getState().closeSpace("space-nats");
    expect(useSpaces.getState().spaces).toHaveLength(1);
  });

  it("closing the active space activates a neighbor and drops its parked view", () => {
    useSpaces.getState().addSpace("kubernetes");
    const k8sSpace = useSpaces.getState().spaces[1]!;
    useUi.getState().setView("k8s.pods");

    useSpaces.getState().closeSpace(k8sSpace.id);
    expect(useSpaces.getState().activeId).toBe("space-nats");
    expect(useSpaces.getState().spaces).toHaveLength(1);
    expect(useSpaces.getState().lastView[k8sSpace.id]).toBeUndefined();
  });

  it("activateDomain stays put when the active space already fits", () => {
    const activateTarget = vi.fn();
    clearDomains();
    registerDomain({
      id: "nats",
      title: "NATS",
      icon: Radio,
      default: true,
      activateTarget,
    });
    useSpaces.setState({
      spaces: [
        { id: "prod", domainId: "nats", targetId: "prod" },
        { id: "staging", domainId: "nats", targetId: "staging" },
      ],
      activeId: "staging",
      lastView: {},
    });

    useSpaces.getState().activateDomain("nats");

    expect(useSpaces.getState().activeId).toBe("staging");
    expect(activateTarget).not.toHaveBeenCalled();
  });

  it("unpins targets that no longer exist, leaving the tab and others alone", () => {
    useSpaces.setState({
      spaces: [
        { id: "a", domainId: "nats", targetId: "gone", targetLabel: "Gone" },
        { id: "b", domainId: "nats", targetId: "prod", targetLabel: "Prod" },
        { id: "c", domainId: "kubernetes", targetId: "gone" },
      ],
      activeId: "a",
      lastView: {},
    });

    useSpaces.getState().pruneTargets("nats", ["prod"]);

    const spaces = useSpaces.getState().spaces;
    expect(spaces).toHaveLength(3);
    expect(spaces[0]).toEqual({ id: "a", domainId: "nats" });
    expect(spaces[1]?.targetId).toBe("prod");
    expect(spaces[2]?.targetId).toBe("gone");
  });

  it("activateDomain jumps to an existing space or creates one", () => {
    useSpaces.getState().addSpace("kubernetes");
    useSpaces.getState().setActive("space-nats");

    useSpaces.getState().activateDomain("kubernetes");
    expect(useSpaces.getState().spaces).toHaveLength(2);
    expect(
      useSpaces
        .getState()
        .spaces.find((s) => s.id === useSpaces.getState().activeId)?.domainId,
    ).toBe("kubernetes");

    useSpaces.getState().activateDomain("kafka");
    expect(useSpaces.getState().spaces).toHaveLength(3);
    expect(
      useSpaces
        .getState()
        .spaces.find((s) => s.id === useSpaces.getState().activeId)?.domainId,
    ).toBe("kafka");
  });
});

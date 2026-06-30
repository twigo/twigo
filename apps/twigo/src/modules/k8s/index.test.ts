import { describe, it, expect } from "vitest";
import { registerK8sModule } from "./index";
import { getDomain, getDomains } from "@/shell/domains";
import { getViews } from "@/shell/views";

// Each test file gets a fresh module graph, so the registries start empty here.
describe("kubernetes module", () => {
  it("registers the kubernetes domain and its views", () => {
    registerK8sModule();
    const domain = getDomain("kubernetes");
    expect(domain?.title).toBe("Kubernetes");
    expect(domain?.ConnectionBar).toBeTypeOf("function");
    expect(getDomains().map((d) => d.id)).toContain("kubernetes");

    const views = getViews("kubernetes");
    expect(views.map((v) => v.id)).toEqual([
      "k8s.pods",
      "k8s.deployments",
      "k8s.services",
      "k8s.nodes",
    ]);
    expect(views.every((v) => v.domain === "kubernetes")).toBe(true);
  });

  it("is idempotent", () => {
    registerK8sModule();
    registerK8sModule();
    expect(getViews("kubernetes")).toHaveLength(4);
  });
});

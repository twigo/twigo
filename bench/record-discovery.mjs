#!/usr/bin/env node
// Usage: node bench/record-discovery.mjs <kubeconfig> > packages/protocol/src/mock/resources.json
//
// Records the listable resources of a kind cluster's discovery, in the shape
// of twigo_ipc::Resource, for the mock backend. Preferred versions only, no
// subresources.
import { execFileSync } from "node:child_process";

const kubeconfig = process.argv[2];
if (!kubeconfig) {
  console.error("usage: node bench/record-discovery.mjs <kubeconfig>");
  process.exit(2);
}

const get = (path) =>
  JSON.parse(
    execFileSync(
      "kubectl",
      ["--kubeconfig", kubeconfig, "get", "--raw", path],
      {
        encoding: "utf8",
      },
    ),
  );

const versions = [
  { group: "", version: "v1", path: "/api/v1" },
  ...get("/apis").groups.map(({ name, preferredVersion }) => ({
    group: name,
    version: preferredVersion.version,
    path: `/apis/${preferredVersion.groupVersion}`,
  })),
];

const resources = versions.flatMap(({ group, version, path }) =>
  get(path)
    .resources.filter(
      (r) =>
        !r.name.includes("/") &&
        r.verbs.includes("list") &&
        r.verbs.includes("watch"),
    )
    .map((r) => ({
      gvr: { group, version, resource: r.name },
      kind: r.kind,
      singular: r.singularName || r.kind.toLowerCase(),
      shortNames: r.shortNames ?? [],
      namespaced: r.namespaced,
    })),
);

process.stdout.write(`${JSON.stringify(resources, null, 2)}\n`);

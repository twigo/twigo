import { expect, test } from "vitest";
import { splitImage } from "./image";

const SHA =
  "sha256:7181c60a3f0d5e8b9a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a";

test.each([
  [
    "docker.io/kindest/local-path-helper:v20260131-7181c60a",
    "docker.io/kindest/",
    "local-path-helper:v20260131-7181c60a",
    "",
  ],
  [
    "registry.k8s.io/coredns/coredns:v1.12.1",
    "registry.k8s.io/coredns/",
    "coredns:v1.12.1",
    "",
  ],
  ["nginx", "", "nginx", ""],
  ["nginx:1.27", "", "nginx:1.27", ""],
  [`localhost:5000/app@${SHA}`, "localhost:5000/", "app", "@sha256:7181…"],
  [
    `ghcr.io/org/team/app:1.4.2@${SHA}`,
    "ghcr.io/org/team/",
    "app:1.4.2",
    "@sha256:7181…",
  ],
])("%s reads %s, %s and %s", (reference, path, name, digest) => {
  expect(splitImage(reference)).toEqual({ path, name, digest });
});

test("a digest of four hex digits or fewer stays whole", () => {
  expect(splitImage("app@sha256:7181").digest).toBe("@sha256:7181");
});

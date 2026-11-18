import { expect, test } from "vitest";
import type { Value } from "@twigo/protocol";
import { copyText, isEmpty, rowOf, stacks } from "./stacking";

const text = (text: string): Value => ({ type: "text", text });
const code = (text: string): Value => ({ type: "code", text });
const AT = "2026-11-03T12:13:01Z";
const OWNER = {
  group: "apps",
  version: "v1",
  kind: "ReplicaSet",
  namespace: "overview",
  name: "api-c8894f678",
};

test.each<[string, Value, boolean]>([
  ["a short word", text("Running"), false],
  ["an address", code("10.244.0.54"), false],
  [
    "a UID at the edge of what fits",
    text("1b638b55-cff7-4253-99ee-2baa87001aea"),
    false,
  ],
  [
    "an image",
    code("docker.io/kindest/local-path-helper:v20260131-7181c60a"),
    true,
  ],
  ["a command with lines", code("sh\n-c\necho hi"), true],
  [
    "a long message",
    text("containers with unready status: [api] and more besides"),
    true,
  ],
  ["a time", { type: "time", at: AT }, false],
  [
    "a link",
    {
      type: "link",
      target: OWNER,
      text: "ReplicaSet/api-c8894f678-and-a-name-that-is-long",
    },
    false,
  ],
  ["a toned word", { type: "toned", text: "0/1", tone: "warning" }, false],
  [
    "one short label",
    { type: "labels", labels: [{ key: "app", value: "api" }] },
    true,
  ],
  ["no labels", { type: "labels", labels: [] }, false],
  [
    "two short items",
    { type: "list", items: [text("kubelet"), text("kubeadm")] },
    true,
  ],
  ["one short address", { type: "list", items: [code("10.244.0.54")] }, true],
  ["no items", { type: "list", items: [] }, false],
  ["items with nothing in them", { type: "list", items: [text("")] }, false],
  [
    "tolerations, which are long",
    {
      type: "list",
      items: [
        text("node.kubernetes.io/not-ready:NoExecute op=Exists for 300s"),
      ],
    },
    true,
  ],
])("%s: stacked is %s", (_, value, stacked) => {
  expect(stacks(value)).toBe(stacked);
});

test.each<[string, Value, string | undefined]>([
  ["text", text("Running"), "Running"],
  [
    "an image",
    code("registry.k8s.io/coredns/coredns:v1.12.1"),
    "registry.k8s.io/coredns/coredns:v1.12.1",
  ],
  ["a time, as the moment it stands for", { type: "time", at: AT }, AT],
  [
    "labels, a line each",
    {
      type: "labels",
      labels: [
        { key: "app", value: "api" },
        { key: "note", value: "" },
      ],
    },
    "app=api\nnote",
  ],
  [
    "a list, a line each",
    { type: "list", items: [text("a"), text(""), text("b")] },
    "a\nb",
  ],
  ["empty text", text(""), undefined],
  ["no labels", { type: "labels", labels: [] }, undefined],
])("copying %s gives %j", (_, value, copied) => {
  expect(copyText(value)).toBe(copied);
});

test("a value with nothing to show is empty, a time never", () => {
  expect(isEmpty(text(""))).toBe(true);
  expect(isEmpty({ type: "list", items: [] })).toBe(true);
  expect(isEmpty(text("0"))).toBe(false);
  expect(isEmpty({ type: "time", at: AT })).toBe(false);
});

test.each<[string, Value, boolean]>([
  ["text", text("kube-api-access-szhp5 (ro)"), true],
  ["code", code("registry.k8s.io/coredns/coredns:v1.12.1"), true],
  ["a time", { type: "time", at: AT }, true],
  ["a toned word", { type: "toned", text: "0/1", tone: "warning" }, true],
  [
    "a name, which is cut and whose link has its whole text as its tooltip",
    { type: "link", target: OWNER, text: "api-c8894f678" },
    false,
  ],
])("%s: wraps is %s", (_, value, wraps) => {
  expect(rowOf(value).wraps).toBe(wraps);
});

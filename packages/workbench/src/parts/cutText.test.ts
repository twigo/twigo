import { expect, test } from "vitest";
import { cutText } from "./cutText";

const NAME = /[:/]/;

test("a text of the floor's length or less is never cut", () => {
  expect(cutText("a".repeat(28), 28, NAME)).toBeUndefined();
  expect(cutText("prod-eu", 28, NAME)).toBeUndefined();
  expect(cutText("All namespaces", 16, ", ")).toBeUndefined();
});

test("a name keeps the part after its last : or / when that is short", () => {
  expect(
    cutText(
      "arn:aws:eks:eu-west-1:123456789012:cluster/payments-prod",
      28,
      NAME,
    ),
  ).toEqual({
    head: "arn:aws:eks:eu-",
    middle: "west-1:123456789012:cluster/",
    tail: "payments-prod",
  });
  expect(
    cutText("gke_acme-prod_europe-west4_main:cluster-1", 28, NAME),
  ).toEqual({
    head: "gke_acme-prod_europ",
    middle: "e-west4_main:",
    tail: "cluster-1",
  });
});

test("a name with a long last part, or none, keeps its last 12 characters", () => {
  const cluster = "arn:aws:eks:eu-west-1:123456789012:cluster/";
  expect(cutText(`${cluster}payments-production`, 28, NAME)?.tail).toBe(
    "s-production",
  );
  expect(cutText(cluster, 28, NAME)?.tail).toBe("012:cluster/");
  expect(
    cutText("prod-eu + staging + dev + qa + kind-local", 28, NAME)?.tail,
  ).toBe("+ kind-local");
});

test("head and tail are the floor's characters together, and with the middle the whole text", () => {
  const texts = [
    "arn:aws:eks:eu-west-1:123456789012:cluster/payments-prod",
    "prod-eu + staging + dev + qa + kind-local",
    "W".repeat(40),
    "a:" + "b".repeat(40),
  ];
  for (const text of texts) {
    const cut = cutText(text, 28, NAME);
    if (!cut) throw new Error(text);
    expect(cut.head.length + cut.tail.length).toBe(28);
    expect(cut.head + cut.middle + cut.tail).toBe(text);
  }
});

test("a scope keeps its last namespace, whole when short, and never splits All namespaces", () => {
  expect(cutText("payments, checkout, ledger", 16, ", ")).toEqual({
    head: "payments, ",
    middle: "checkout, ",
    tail: "ledger",
  });
  expect(
    cutText("payments, checkout, ledger, platform-observability", 16, ", "),
  ).toEqual({
    head: "paym",
    middle: "ents, checkout, ledger, platform-o",
    tail: "bservability",
  });
});

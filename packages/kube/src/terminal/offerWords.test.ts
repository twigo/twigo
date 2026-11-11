import { expect, test } from "vitest";
import type { KubeconfigOffer } from "@twigo/protocol";
import { describeOffer, nameParts } from "./offerWords";

const offer = (more: Partial<KubeconfigOffer>): KubeconfigOffer => ({
  id: 1,
  terminal: "Terminal 3",
  session: 7,
  context: "dev",
  contexts: [],
  clusters: [],
  users: [],
  target: "~/.kube/config",
  leftOut: { contexts: [], clusters: [], users: [] },
  ...more,
});

const ARN = "arn:aws:eks:eu-west-1:123456789012:cluster";

const REASON =
  "Left out: your files have that name already, or what the context names is another entry there or missing, and does not move with it.";

test("an offer says which terminal and context the entries came from, how many of each section came, and where a move writes them", () => {
  expect(
    describeOffer(offer({ contexts: ["a"], clusters: ["a"], users: ["a"] })),
  ).toMatchObject({
    title:
      "Terminal 3 in dev added a context, a cluster and a user to its own kubeconfig.",
    move: "Move to ~/.kube/config",
  });
  expect(
    describeOffer(
      offer({ contexts: ["a", "b"], clusters: ["a", "b"], users: ["a"] }),
    ).title,
  ).toBe(
    "Terminal 3 in dev added 2 contexts, 2 clusters and a user to its own kubeconfig.",
  );
  expect(describeOffer(offer({ clusters: ["a"], users: ["u"] })).title).toBe(
    "Terminal 3 in dev added a cluster and a user to its own kubeconfig.",
  );
});

test("a name that a context, a cluster and a user share is one line with the kinds it names, as cloud CLIs name all three alike", () => {
  const words = describeOffer(
    offer({
      contexts: [`${ARN}/prod-eu-2`],
      clusters: [`${ARN}/prod-eu-2`],
      users: [`${ARN}/prod-eu-2`],
    }),
  );
  expect(words.names).toEqual([
    {
      name: `${ARN}/prod-eu-2`,
      kinds: "context, cluster, user",
      leftOut: false,
    },
  ]);
  expect(words.all).toEqual(words.names);
  expect(words.more).toBeUndefined();
  expect(words.reason).toBeUndefined();
});

test("names that differ by section are lines of their own, in the order the sections come", () => {
  const words = describeOffer(
    offer({
      contexts: ["ctx", "shared"],
      clusters: ["shared", "cl"],
      users: ["usr"],
    }),
  );
  expect(words.names.map(({ name, kinds }) => [name, kinds])).toEqual([
    ["ctx", "context"],
    ["shared", "context, cluster"],
    ["cl", "cluster"],
    ["usr", "user"],
  ]);
});

test("a name that a move leaves out is marked on its line, the kinds it leaves out after the ones it writes", () => {
  const words = describeOffer(
    offer({
      contexts: [`${ARN}/prod-eu-2`, `${ARN}/prod-eu-3`, "mixed"],
      clusters: [`${ARN}/prod-eu-2`, `${ARN}/prod-eu-3`, "mixed"],
      users: [`${ARN}/prod-eu-2`, `${ARN}/prod-eu-3`, "mixed"],
      leftOut: {
        contexts: [`${ARN}/prod-eu-3`],
        clusters: [`${ARN}/prod-eu-3`],
        users: [`${ARN}/prod-eu-3`, "mixed"],
      },
    }),
  );
  expect(words.names).toEqual([
    {
      name: `${ARN}/prod-eu-2`,
      kinds: "context, cluster, user",
      leftOut: false,
    },
    {
      name: `${ARN}/prod-eu-3`,
      kinds: "context, cluster, user left out",
      leftOut: true,
    },
    { name: "mixed", kinds: "context, cluster · user left out", leftOut: true },
  ]);
});

test("the reason is one sentence below the names, the same for every section a name is left out of, and none where nothing is", () => {
  const leaving = (section: "contexts" | "clusters" | "users") =>
    describeOffer(
      offer({
        contexts: ["a", "b"],
        clusters: ["a", "b"],
        users: ["a", "b"],
        leftOut: { contexts: [], clusters: [], users: [], [section]: ["b"] },
      }),
    ).reason;
  expect(leaving("contexts")).toBe(REASON);
  expect(leaving("clusters")).toBe(REASON);
  expect(leaving("users")).toBe(REASON);
  expect(
    describeOffer(offer({ contexts: ["a"], clusters: ["a"], users: ["a"] }))
      .reason,
  ).toBeUndefined();
});

test("an offer of more than four names shows four and says how many more, with every name kept for a tooltip", () => {
  const names = ["a", "b", "c", "d", "e", "f"].map((n) => `${ARN}/${n}`);
  const words = describeOffer(
    offer({
      contexts: names,
      clusters: names,
      users: names,
      leftOut: { contexts: [names[5] ?? ""], clusters: [], users: [] },
    }),
  );
  expect(words.names.map(({ name }) => name)).toEqual(names.slice(0, 4));
  expect(words.more).toBe("and 2 more");
  expect(words.all.map(({ name }) => name)).toEqual(names);
  expect(words.all[5]).toEqual({
    name: `${ARN}/f`,
    kinds: "cluster, user · context left out",
    leftOut: true,
  });
});

test("four names are shown whole, and one more is one more", () => {
  const some = (n: number) =>
    describeOffer(offer({ users: ["a", "b", "c", "d", "e"].slice(0, n) }));
  expect(some(4).more).toBeUndefined();
  expect(some(4).names).toHaveLength(4);
  expect(some(5).more).toBe("and 1 more");
  expect(some(5).names).toHaveLength(4);
});

test("a name breaks after its own colons and slashes, never inside a word", () => {
  expect(nameParts(`${ARN}/prod-eu-2`)).toEqual([
    "arn:",
    "aws:",
    "eks:",
    "eu-west-1:",
    "123456789012:",
    "cluster/",
    "prod-eu-2",
  ]);
  expect(nameParts("gke_proj_europe-west1-b_prod")).toEqual([
    "gke_proj_europe-west1-b_prod",
  ]);
  expect(nameParts("a:")).toEqual(["a:"]);
});

import { expect, test } from "vitest";
import type { KubeconfigOffer } from "@twigo/protocol";
import { describeOffer } from "./offerWords";

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

test("a move writes the names of each section that it does not leave out, and a section with none is not listed", () => {
  const words = describeOffer(
    offer({
      contexts: ["a", "b"],
      clusters: ["a", "b"],
      users: ["a", "u-b"],
      leftOut: { contexts: ["b"], clusters: ["b"], users: [] },
    }),
  );
  expect(words.moves).toEqual([
    { label: "Contexts", names: ["a"] },
    { label: "Clusters", names: ["a"] },
    { label: "Users", names: ["a", "u-b"] },
  ]);
  expect(
    describeOffer(
      offer({
        contexts: ["a"],
        clusters: ["a"],
        users: ["a"],
        leftOut: { contexts: ["a"], clusters: ["a"], users: ["a"] },
      }),
    ).moves,
  ).toEqual([]);
});

test("a move leaves out names by section, with what a person can look for in their files", () => {
  const words = describeOffer(
    offer({
      contexts: ["a", "b"],
      clusters: ["a", "b"],
      users: ["a", "b"],
      leftOut: { contexts: ["b"], clusters: ["b"], users: ["b"] },
    }),
  );
  expect(words.leaves).toEqual([
    {
      label: "Contexts",
      names: ["b"],
      reason:
        "Your files have a context of that name, or the cluster or user it names is another one in your files, or your files lack it and it does not move with the context.",
    },
    {
      label: "Clusters",
      names: ["b"],
      reason:
        "Your files have a cluster of that name, or only contexts left out name it.",
    },
    {
      label: "Users",
      names: ["b"],
      reason:
        "Your files have a user of that name, or only contexts left out name it.",
    },
  ]);
});

test("a cluster left out with no context left out is one that the person's files have, and an offer that leaves nothing out lists nothing", () => {
  const words = describeOffer(
    offer({
      contexts: ["a"],
      clusters: ["a", "b"],
      users: ["a"],
      leftOut: { contexts: [], clusters: ["b"], users: [] },
    }),
  );
  expect(words.leaves).toEqual([
    {
      label: "Clusters",
      names: ["b"],
      reason: "Your files have a cluster of that name.",
    },
  ]);
  expect(
    describeOffer(offer({ contexts: ["a"], clusters: ["a"], users: ["a"] }))
      .leaves,
  ).toEqual([]);
});

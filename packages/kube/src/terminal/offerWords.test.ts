import { expect, test } from "vitest";
import type { KubeconfigOffer } from "@twigo/protocol";
import { describeOffer } from "./offerWords";

const offer = (more: Partial<KubeconfigOffer>): KubeconfigOffer => ({
  id: 1,
  terminal: "Terminal 3",
  contexts: [],
  clusters: [],
  users: [],
  target: "~/.kube/config",
  taken: [],
  ...more,
});

test("an offer says how many entries of each kind came, and where a move writes them", () => {
  expect(
    describeOffer(offer({ contexts: ["a"], clusters: ["a"], users: ["a"] })),
  ).toMatchObject({
    title:
      "Terminal 3 added a context, a cluster and a user to its own kubeconfig.",
    move: "Move to ~/.kube/config",
  });
  expect(
    describeOffer(
      offer({ contexts: ["a", "b"], clusters: ["a", "b"], users: ["a"] }),
    ).title,
  ).toBe(
    "Terminal 3 added 2 contexts, 2 clusters and a user to its own kubeconfig.",
  );
  expect(describeOffer(offer({ clusters: ["a"], users: ["u"] })).title).toBe(
    "Terminal 3 added a cluster and a user to its own kubeconfig.",
  );
});

test("a name that several kinds of entry carry is listed once with its kinds, and what the person's files hold is left out of the move", () => {
  const words = describeOffer(
    offer({
      contexts: ["a", "b"],
      clusters: ["a", "b"],
      users: ["a", "u-b"],
      taken: ["b"],
    }),
  );
  expect(words.moves).toEqual([
    { name: "a", kinds: ["context", "cluster", "user"] },
    { name: "u-b", kinds: ["user"] },
  ]);
  expect(words.leaves).toEqual([{ name: "b", kinds: ["context", "cluster"] }]);
});

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { INITIAL_OBJECT, type ObjectSnapshot } from "@twigo/protocol";
import { ObjectContent, RelatedView } from "./ObjectContent";

afterEach(() => {
  cleanup();
});

test("owned objects that cannot be listed say why instead of none", () => {
  render(
    <RelatedView
      related={{
        owners: [],
        owned: [],
        unavailable: "You may not list pods.",
      }}
      onOpen={() => undefined}
    />,
  );
  const owns = screen.getByRole("region", { name: "Owns" });
  expect(owns.textContent).toContain("You may not list pods.");
  expect(within(owns).queryByText("None")).toBeNull();
});

const deleted: ObjectSnapshot = {
  ...INITIAL_OBJECT,
  status: { state: "ready" },
  exists: false,
};

function yamlOf(snapshot: ObjectSnapshot, kept?: boolean) {
  render(
    <ObjectContent
      tab="yaml"
      space="dev"
      states={{} as never}
      kind="apps/deployments"
      snapshot={snapshot}
      values={{} as never}
      yaml={() => <p>the live editor</p>}
      {...(kept && {
        kept: ({ title, body }: { title: string; body: string }) => (
          <p>
            the edit stays: {title}. {body}
          </p>
        ),
      })}
      onOpen={() => undefined}
    />,
  );
}

test("an object that is gone, or cannot be read, leaves its edit reachable when it has one", () => {
  const unreadable: Record<string, ObjectSnapshot> = {
    "not found": deleted,
    error: {
      ...INITIAL_OBJECT,
      status: {
        state: "error",
        error: { kind: "unavailable", message: "no route to host" },
      },
    },
    forbidden: {
      ...INITIAL_OBJECT,
      status: { state: "forbidden", verb: "get", resource: "deployments" },
    },
  };
  for (const [why, snapshot] of Object.entries(unreadable)) {
    yamlOf(snapshot, true);
    expect(screen.getByText(/the edit stays/).textContent, why).toContain(
      "the edit stays",
    );
    cleanup();
    yamlOf(snapshot);
    expect(screen.queryByText(/the edit stays/), why).toBeNull();
    cleanup();
  }
  yamlOf(deleted, true);
  expect(
    screen.getByText(/The object does not exist\. It is gone/),
  ).toBeTruthy();
  cleanup();
  yamlOf(deleted);
  expect(screen.getByText("The object does not exist")).toBeTruthy();
});

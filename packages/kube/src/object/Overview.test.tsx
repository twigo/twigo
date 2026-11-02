import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Overview as Document } from "@twigo/protocol";
import { Overview } from "./Overview";

afterEach(() => {
  cleanup();
});

const KEYS = 2000;

function configMap(): Document {
  return {
    sections: [
      {
        id: "core.data",
        title: "Data",
        blocks: [
          {
            type: "data",
            entries: Array.from({ length: KEYS }, (_, index) => ({
              key: `key-${index}`,
              bytes: 12,
              binary: false,
            })),
          },
        ],
      },
    ],
  };
}

test("a ConfigMap of 2,000 keys puts in the DOM the values of the keys opened only", async () => {
  const values = vi.fn((keys: readonly string[]) =>
    Promise.resolve(keys.map((key) => `value of ${key}`)),
  );
  render(
    <Overview
      overview={configMap()}
      onOpen={() => undefined}
      values={values}
    />,
  );
  expect(screen.getAllByRole("button", { expanded: false })).toHaveLength(KEYS);
  expect(document.body.textContent).not.toContain("value of");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /key-1500/ }));
    await Promise.resolve();
  });
  expect(values).toHaveBeenCalledWith(["key-1500"]);
  expect(document.body.textContent).toContain("value of key-1500");
  expect(document.body.textContent.match(/value of/g)).toHaveLength(1);
});

test("a link opens the object it points at", () => {
  const onOpen = vi.fn();
  const target = {
    group: "apps",
    version: "v1",
    kind: "ReplicaSet",
    namespace: "payments",
    name: "web-1",
  };
  render(
    <Overview
      overview={{
        sections: [
          {
            id: "core.metadata",
            title: "Metadata",
            blocks: [
              {
                type: "fields",
                fields: [
                  {
                    label: "Controlled by",
                    value: { type: "link", target, text: "ReplicaSet/web-1" },
                  },
                ],
              },
            ],
          },
        ],
      }}
      onOpen={onOpen}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "ReplicaSet/web-1" }));
  expect(onOpen).toHaveBeenCalledWith(target);
});

test("a section folds by its title", () => {
  render(<Overview overview={configMap()} onOpen={() => undefined} />);
  expect(screen.getByText("key-0")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Data" }));
  expect(screen.queryByText("key-0")).toBeNull();
});

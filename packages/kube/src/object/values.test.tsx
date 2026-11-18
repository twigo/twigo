import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Label, Value } from "@twigo/protocol";
import { ImageName, Prose, ValueView } from "./values";

afterEach(cleanup);

const view = (value: Value, compact = false) =>
  render(
    <ValueView value={value} onOpen={() => undefined} compact={compact} />,
  );

test.each<[string, Value]>([
  ["empty text", { type: "text", text: "" }],
  ["empty code", { type: "code", text: "" }],
  ["no labels", { type: "labels", labels: [] }],
  ["no items", { type: "list", items: [] }],
])("%s is a dash in the quiet role, in a row and in a cell", (_, value) => {
  for (const compact of [false, true]) {
    const { container } = view(value, compact);
    expect(container.textContent).toBe("–");
    expect(container.firstElementChild?.className).toContain("text-quiet");
    cleanup();
  }
});

test("a time reads as its age alone, and its date is in its tooltip", () => {
  const at = new Date(Date.now() - (11 * 24 * 60 + 30) * 60_000).toISOString();
  const { container } = view({ type: "time", at });
  expect(container.textContent).toBe("11d ago");
  expect(container.firstElementChild?.getAttribute("title")).toBe(
    new Date(at).toLocaleString(),
  );
});

test("a sentence of text and times reads as one line, its age ticking from its moment", () => {
  const at = new Date(Date.now() - (11 * 24 * 60 + 30) * 60_000).toISOString();
  const { container } = view({
    type: "spans",
    spans: [
      { type: "text", text: "code 1 (Error) · " },
      { type: "ago", at },
    ],
  });
  expect(container.textContent).toBe("code 1 (Error) · 11d ago");
});

test("a name that is a link has its whole text in its tooltip, where its copy icon hides the end of a cut one", () => {
  const text = "payments-api-production-checkout-7d9f8c6b5-x2x4q";
  const { container } = view({
    type: "link",
    target: {
      group: "apps",
      version: "v1",
      kind: "Deployment",
      namespace: "payments",
      name: text,
    },
    text,
  });
  expect(container.querySelector("button")?.getAttribute("title")).toBe(text);
});

const labels = (count: number): Label[] =>
  Array.from({ length: count }, (_, at) => ({
    key: `app.kubernetes.io/part-${String(at)}`,
    value: `v${String(at)}`,
  }));

test("labels show three, then Show all with their count, and Show fewer takes them back", () => {
  view({ type: "labels", labels: labels(9) });
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Show all 9" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(9);
  fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
});

test("three labels or fewer have no Show all", () => {
  view({ type: "labels", labels: labels(3) });
  expect(screen.queryByRole("button")).toBeNull();
});

test("a key's domain prefix is quiet and its name is not", () => {
  view({
    type: "labels",
    labels: [{ key: "app.kubernetes.io/name", value: "api" }],
  });
  expect(screen.getByText("app.kubernetes.io/").className).toContain(
    "text-quiet",
  );
  expect(screen.getByText("name").className).not.toContain("text-quiet");
});

test("an annotation value of more than two lines folds and opens on a click, and one of two does not", () => {
  const line = "x".repeat(80);
  view({
    type: "labels",
    labels: [
      { key: "short", value: `${line}\n${line}` },
      { key: "long", value: `${line}\n${line}\n${line}` },
    ],
  });
  expect(screen.getAllByRole("button")).toHaveLength(1);
  const long = screen.getByRole("button");
  expect(long.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(long);
  expect(long.getAttribute("aria-expanded")).toBe("true");
});

test("a folded annotation clamps an element inside its button, since WebKit does not clamp a button", () => {
  view({
    type: "labels",
    labels: [{ key: "long", value: "x\n".repeat(5) }],
  });
  const button = screen.getByRole("button");
  expect(button.className).not.toContain("line-clamp");
  expect(button.firstElementChild?.className).toContain("line-clamp-2");
  fireEvent.click(button);
  expect(button.firstElementChild?.className).not.toContain("line-clamp");
});

test("kubectl's copy of the object is folded from the start and its value stays out of the page until opened", () => {
  view({
    type: "labels",
    labels: [
      {
        key: "kubectl.kubernetes.io/last-applied-configuration",
        value: '{"apiVersion":"v1"}',
      },
    ],
  });
  expect(document.body.textContent).not.toContain("apiVersion");
  fireEvent.click(screen.getByRole("button"));
  expect(document.body.textContent).toContain('{"apiVersion":"v1"}');
});

test("prose of more than three lines folds to three and says more, and shorter prose says nothing", () => {
  render(<Prose text={"a line\n".repeat(3).trim()} />);
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  const text = "a line\n".repeat(4).trim();
  render(<Prose text={text} />);
  const more = screen.getByRole("button", { name: "more" });
  fireEvent.click(more);
  expect(screen.getByRole("button", { name: "less" })).toBeTruthy();
  expect(document.body.textContent).toContain(text.split("\n")[3]);
});

test("an image with no registry or digest has the name alone", () => {
  const { container } = render(<ImageName image="nginx" />);
  expect(container.firstElementChild?.children).toHaveLength(1);
});

test("an image names where it is kept before what it is called, folds its digest, and holds the whole reference in its tooltip", () => {
  const reference =
    "localhost:5000/app:1.4@sha256:7181c60a3f0d5e8b9a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a";
  const { container } = render(<ImageName image={reference} />);
  expect(
    [...(container.firstElementChild?.children ?? [])].map(
      (part) => part.textContent,
    ),
  ).toEqual(["localhost:5000/", "app:1.4", "@sha256:7181…"]);
  expect(container.firstElementChild?.getAttribute("title")).toBe(reference);
});

test("an image's registry and path are quiet like its digest, since in the light theme the support role is too near the name", () => {
  const { container } = render(
    <ImageName image="docker.io/kindest/local-path-helper:v20260131@sha256:7181c60a3f0d5e8b9a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a" />,
  );
  const [path, name, digest] = [
    ...(container.firstElementChild?.children ?? []),
  ].map((part) => part.className);
  expect(path).toContain("text-quiet");
  expect(name).toContain("text-content");
  expect(digest).toContain("text-quiet");
});

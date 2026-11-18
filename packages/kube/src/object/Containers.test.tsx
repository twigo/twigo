import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Container, Field } from "@twigo/protocol";
import { Containers } from "./Containers";
import { OverviewStates } from "./overviewStates";
import type { GroupFolds } from "./pageStates";

afterEach(cleanup);

const field = (label: string, text: string): Field => ({
  label,
  value: { type: "text", text },
  default: false,
});

const API: Container = {
  name: "api",
  role: "regular",
  image:
    "docker.io/kindest/local-path-helper:v20260131-7181c60a@sha256:7181c60a3f0d5e8b9a1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a",
  state: null,
  ports: [],
  fields: [],
  details: [field("Command", "sh -c run"), field("Image ID", "sha256:8f37")],
  env: [],
  mounts: [field("/var/run/secrets", "kube-api-access (ro)")],
};

function shown(
  container: Container = API,
  states = new OverviewStates(),
  groups?: GroupFolds,
) {
  render(
    <Containers
      containers={[container]}
      states={states}
      kind="/pods"
      onOpen={() => undefined}
      groups={groups}
    />,
  );
  return states;
}

test("details, variables and mounts are one line of counts that names only the groups that have something", () => {
  shown();
  expect(
    screen
      .getAllByRole("button", { expanded: false })
      .map((button) => button.textContent),
  ).toEqual(["Details 2", "Mounts 1"]);
  expect(screen.queryByText("Command")).toBeNull();
});

test("a group opens in place below the line, and the kind remembers it", () => {
  const states = shown();
  fireEvent.click(screen.getByRole("button", { name: "Mounts 1" }));
  expect(screen.getByText("/var/run/secrets")).toBeTruthy();
  expect(screen.queryByText("Command")).toBeNull();
  expect(states.open("/pods", "containers/api/Mounts", false)).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "Mounts 1" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Details 2" }));
  expect(screen.getByText("Command")).toBeTruthy();
  expect(screen.getByText("/var/run/secrets")).toBeTruthy();
});

test("the image's copy icon gives the whole reference, digest and all", () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  shown();
  fireEvent.click(screen.getByRole("button", { name: "Copy image" }));
  expect(writeText).toHaveBeenCalledWith(API.image);
});

test("the image's copy icon comes first in the image's block, so that it floats at the end of the first line and covers none of the tag", () => {
  shown();
  const block = screen.getByRole("button", {
    name: "Copy image",
  }).parentElement;
  expect([...(block?.children ?? [])].map((child) => child.tagName)).toEqual([
    "BUTTON",
    "CODE",
  ]);
});

test("each open group has a caption that names it, so a mount does not read as one more detail, and a closed one has none", () => {
  shown({ ...API, env: [field("LOG_LEVEL", "debug")] });
  expect(screen.queryByRole("group")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Mounts 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Env 1" }));
  const groups = screen.getAllByRole("group");
  for (const group of groups) {
    expect(group.hasAttribute("aria-label")).toBe(false);
  }
  const [env, mounts] = groups;
  if (!env || !mounts) throw new Error("two groups");
  expect(screen.getByRole("group", { name: "Environment" })).toBe(env);
  expect(screen.getByRole("group", { name: "Mounts" })).toBe(mounts);
  expect(env.getAttribute("aria-labelledby")).toBe(
    within(env).getByText("Environment").id,
  );
  expect(within(env).getByText("Environment")).toBeTruthy();
  expect(within(env).getByText("LOG_LEVEL")).toBeTruthy();
  expect(within(mounts).getByText("Mounts")).toBeTruthy();
  expect(within(mounts).getByText("/var/run/secrets")).toBeTruthy();
  expect(screen.queryByRole("group", { name: "Details" })).toBeNull();
});

const PULL: Field = {
  ...field("Image pull policy", "IfNotPresent"),
  default: true,
};
const POLICED: Container = {
  ...API,
  details: [field("Command", "sh -c run"), PULL],
};

test("a group's defaults hide behind their count at its end, draw tagged once shown, and the kind remembers the choice", () => {
  const states = shown(POLICED);
  fireEvent.click(screen.getByRole("button", { name: "Details 2" }));
  const group = screen.getByRole("group", { name: "Details" });
  expect(within(group).getByText("Command")).toBeTruthy();
  expect(within(group).queryByText("Image pull policy")).toBeNull();
  const link = within(group).getByRole("button", { name: "1 default" });
  expect(group.lastElementChild).toBe(link);
  fireEvent.click(link);
  expect(within(group).getByText("Image pull policy")).toBeTruthy();
  expect(
    within(group).getByText("IfNotPresent").parentElement?.className,
  ).toContain("text-support");
  expect(within(group).getByText("default")).toBeTruthy();
  expect(states.open("/pods", "containers/api/Details/defaults", false)).toBe(
    true,
  );
  cleanup();
  shown(POLICED, states);
  expect(screen.getByText("Image pull policy")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide defaults" }));
  expect(screen.queryByText("Image pull policy")).toBeNull();
  expect(screen.getByRole("button", { name: "1 default" })).toBeTruthy();
});

test("a group of defaults only is named by its count and opens to the link that shows them", () => {
  shown({ ...API, details: [PULL], mounts: [] });
  fireEvent.click(screen.getByRole("button", { name: "Details 1" }));
  const group = screen.getByRole("group", { name: "Details" });
  expect(within(group).queryByRole("term")).toBeNull();
  expect(within(group).queryByText("Image pull policy")).toBeNull();
  fireEvent.click(within(group).getByRole("button", { name: "1 default" }));
  expect(within(group).getByText("Image pull policy")).toBeTruthy();
});

const folds = (narrowed: boolean): GroupFolds => ({
  open: () => true,
  set: () => undefined,
  narrowed: () => narrowed,
});

test("a group the filter narrowed shows the rows it kept, the defaults among them, with no link; a group it left whole keeps its link", () => {
  shown(POLICED, new OverviewStates(), folds(true));
  expect(screen.getByText("Image pull policy")).toBeTruthy();
  expect(screen.getByText("default")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /default/ })).toBeNull();
  cleanup();
  shown(POLICED, new OverviewStates(), folds(false));
  expect(screen.queryByText("Image pull policy")).toBeNull();
  expect(screen.getByRole("button", { name: "1 default" })).toBeTruthy();
});

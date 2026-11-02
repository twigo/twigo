import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MockScenario } from "@twigo/protocol/mock";
import { inWorkbench, testWorkbench } from "../../testing";
import { CredentialsItem } from "./CredentialsItem";
import { SignInBody } from "./SignIn";
import { TrustDialog } from "./TrustDialog";

afterEach(cleanup);

async function show(scenario: MockScenario) {
  const workbench = await testWorkbench(scenario);
  await act(() => workbench.credentials.start());
  render(
    <>
      <CredentialsItem />
      <TrustDialog />
    </>,
    { wrapper: inWorkbench(workbench) },
  );
  return workbench;
}

test("ready credentials show nothing", async () => {
  await show("ready");
  await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
  expect(document.body.textContent).toBe("");
});

test("the panel shows the device code and the link to enter it at", async () => {
  await show("deviceCode");
  expect(await screen.findByText("F3JQ7K9PL")).toBeTruthy();
  expect(screen.getByText("https://microsoft.com/devicelogin")).toBeTruthy();
  expect(screen.getByText("Sign in to prod-eu")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Signing in…" })).toBeTruthy();
});

test("a failed plugin names its fix and tries again", async () => {
  await show("pluginFailed");
  fireEvent.click(
    await screen.findByRole("button", { name: "No credentials" }),
  );
  expect(
    screen.getByText("exec: executable aws failed with exit code 255"),
  ).toBeTruthy();
  expect(screen.getByText("aws sso login --profile dev-admin")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(
    await screen.findByRole("button", { name: "Running aws…" }),
  ).toBeTruthy();
});

test("the trust prompt shows the whole command before anything runs", async () => {
  await show("untrusted");
  expect(await screen.findByText("Run this command for prod-eu?")).toBeTruthy();
  expect(document.body.textContent).toContain(
    "--server-id 6dae42f8-4368-4678-94ff-3960e28e3630",
  );
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(screen.queryByText("Run this command for prod-eu?")).toBeNull();
  expect(screen.getByRole("button", { name: "Trust kubelogin?" })).toBeTruthy();
});

test("the link opens through Rust and is no anchor the webview could follow", async () => {
  const workbench = await show("deviceCode");
  const invoke = vi.spyOn(workbench.backend, "invoke");
  const link = await screen.findByRole("button", {
    name: "https://microsoft.com/devicelogin",
  });
  expect(document.querySelector("a[href]")).toBeNull();
  fireEvent.click(link);
  expect(invoke).toHaveBeenCalledWith(
    "url_open",
    "https://microsoft.com/devicelogin",
  );
});

test("Escape and clicks go to the app and leave the panel, and the focus, where they were", async () => {
  await show("deviceCode");
  expect(await screen.findByText("F3JQ7K9PL")).toBeTruthy();
  const field = document.createElement("input");
  document.body.append(field);
  fireEvent.pointerDown(field);
  fireEvent.mouseDown(field);
  fireEvent.click(field);
  field.focus();
  expect(screen.getByText("F3JQ7K9PL")).toBeTruthy();
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  field.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(false);
  expect(screen.getByText("F3JQ7K9PL")).toBeTruthy();
  expect(document.activeElement).toBe(field);
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));
  expect(screen.queryByText("F3JQ7K9PL")).toBeNull();
  expect(document.activeElement).toBe(field);
  field.remove();
});

test("the elapsed time counts from the run's start", async () => {
  const workbench = await show("deviceCode");
  await screen.findByText("F3JQ7K9PL");
  const { auth } = workbench.credentials;
  if (auth.state !== "plugin" || auth.status.state !== "running") {
    throw new Error("a run under way");
  }
  cleanup();
  render(
    <SignInBody
      plugin={auth.plugin}
      context="prod-eu"
      status={{
        ...auth.status,
        since: new Date(Date.now() - 65_000).toISOString(),
      }}
    />,
    { wrapper: inWorkbench(workbench) },
  );
  expect(await screen.findByText("1:05")).toBeTruthy();
});

test("the output opens when the run fails after it printed", async () => {
  const workbench = await show("deviceCode");
  expect(
    await screen.findByRole("button", { name: "Show output" }),
  ).toBeTruthy();
  await act(() => workbench.credentials.cancel());
  expect(
    await screen.findByRole("button", { name: "Hide output" }),
  ).toBeTruthy();
});

test("the status bar names a plugin by its command's name, not its path", async () => {
  const workbench = await show("review");
  await act(() => workbench.credentials.answerReview([]));
  await act(() => workbench.spaces.open("qa"));
  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
  expect(
    await screen.findByRole("button", { name: "Trust tsh?" }),
  ).toBeTruthy();
});

test("a copy the clipboard refuses is reported", async () => {
  const writeText = vi.fn(() => Promise.reject(new Error("denied")));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const workbench = await show("deviceCode");
  const report = vi.spyOn(workbench, "report");
  fireEvent.click(await screen.findByRole("button", { name: "Copy code" }));
  await vi.waitFor(() => {
    expect(report).toHaveBeenCalledWith(new Error("denied"));
  });
  expect(writeText).toHaveBeenCalledWith("F3JQ7K9PL");
});

test("the panel sits with its item, which closes and opens it", async () => {
  await show("deviceCode");
  const panel = await screen.findByRole("region", { name: "Sign in" });
  const item = screen.getByRole("button", { name: "Signing in…" });
  expect(panel.parentElement).toBe(item.parentElement);
  fireEvent.click(item);
  expect(screen.queryByRole("region", { name: "Sign in" })).toBeNull();
  fireEvent.click(item);
  expect(screen.getByRole("region", { name: "Sign in" })).toBeTruthy();
});

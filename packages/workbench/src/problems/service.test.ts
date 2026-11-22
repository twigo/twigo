import { expect, test, vi } from "vitest";
import type { Backend, IpcError } from "@twigo/protocol";
import { Problems } from "./service";

const problem = (code: IpcError["code"], message?: string): IpcError =>
  ({ code, kind: "internal", message: message ?? code }) as unknown as IpcError;

function listing(first: IpcError[]) {
  let send: ((next: IpcError[]) => void) | undefined;
  const backend = {
    invoke: vi.fn(),
    subscribe: vi.fn((_command: string, _request: unknown, on: typeof send) => {
      send = on;
      return Promise.resolve(first);
    }),
  } as unknown as Backend;
  return { backend, send: (next: IpcError[]) => send?.(next) };
}

test("each problem is announced when its code is listed, and not again when its words change", async () => {
  const { backend, send } = listing([problem("state.set-aside")]);
  const announce = vi.fn();
  const problems = new Problems(backend, announce, () => undefined);
  await problems.watch();
  expect(problems.list.map(({ code }) => code)).toEqual(["state.set-aside"]);
  expect(announce).toHaveBeenCalledTimes(1);

  send([problem("state.set-aside", "other words"), problem("audit.off")]);
  expect(announce.mock.calls.map(([told]) => (told as IpcError).code)).toEqual([
    "state.set-aside",
    "audit.off",
  ]);
});

test("a problem that leaves the list is cleared, and told again when it comes back", async () => {
  const { backend, send } = listing([
    problem("state.unsaved"),
    problem("audit.off"),
  ]);
  const announce = vi.fn();
  const cleared = vi.fn();
  const problems = new Problems(backend, announce, cleared);
  await problems.watch();
  expect(announce).toHaveBeenCalledTimes(2);
  expect(cleared).not.toHaveBeenCalled();

  send([problem("audit.off")]);
  expect(cleared.mock.calls).toEqual([["state.unsaved"]]);
  expect(announce).toHaveBeenCalledTimes(2);

  send([problem("audit.off"), problem("state.unsaved")]);
  expect(announce.mock.calls.map(([told]) => (told as IpcError).code)).toEqual([
    "state.unsaved",
    "audit.off",
    "state.unsaved",
  ]);
  expect(cleared).toHaveBeenCalledTimes(1);
});

test("a change that arrives before the answer is the newer list", async () => {
  const early = [problem("audit.off")];
  const backend = {
    invoke: vi.fn(),
    subscribe: vi.fn(
      (_command: string, _request: unknown, on: (next: unknown) => void) => {
        on(early);
        return Promise.resolve([problem("state.set-aside")]);
      },
    ),
  } as unknown as Backend;
  const problems = new Problems(
    backend,
    () => undefined,
    () => undefined,
  );
  await problems.watch();
  expect(problems.list.map(({ code }) => code)).toEqual(["audit.off"]);
});

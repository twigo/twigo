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

test("each problem is announced the first time its code is listed, and not again when its words change or it is listed anew", async () => {
  const { backend, send } = listing([problem("state.set-aside")]);
  const announce = vi.fn();
  const problems = new Problems(backend, announce);
  await problems.watch();
  expect(problems.list.map(({ code }) => code)).toEqual(["state.set-aside"]);
  expect(announce).toHaveBeenCalledTimes(1);

  send([problem("state.set-aside", "other words"), problem("audit.off")]);
  expect(announce.mock.calls.map(([told]) => (told as IpcError).code)).toEqual([
    "state.set-aside",
    "audit.off",
  ]);
  send([]);
  send([problem("audit.off")]);
  expect(announce).toHaveBeenCalledTimes(2);
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
  const problems = new Problems(backend, () => undefined);
  await problems.watch();
  expect(problems.list.map(({ code }) => code)).toEqual(["audit.off"]);
});

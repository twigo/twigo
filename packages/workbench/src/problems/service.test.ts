import { expect, test, vi } from "vitest";
import type { Backend, IpcError } from "@twigo/protocol";
import { Problems } from "./service";

const problem = (code: IpcError["code"]): IpcError =>
  ({ code, kind: "internal", message: code }) as unknown as IpcError;

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

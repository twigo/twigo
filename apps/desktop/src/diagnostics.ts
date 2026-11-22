import type { RootOptions } from "react-dom/client";
import { IpcError, type Backend, type RequestOf } from "@twigo/protocol";

type Entry = RequestOf<"diagnostics_log">;

/**
 * Sends what the page fails to catch, and what React's root catches, to the
 * diagnostics log (ARCHITECTURE 4.10). `root` is the options of the React root
 * that do the second, and `caught` tells the log of an error that the page
 * handled itself and shows. The same message and stack are sent once, then
 * counted: the count reaches the log each time it doubles.
 */
export function logWebviewErrors(backend: Pick<Backend, "invoke">): {
  root: Pick<
    RootOptions,
    "onCaughtError" | "onUncaughtError" | "onRecoverableError"
  >;
  caught: (source: string, reason: unknown) => void;
} {
  const seen = new Map<string, number>();

  const send = (entry: Entry) => {
    // The log is where errors go: one that cannot reach it has nowhere else.
    backend.invoke("diagnostics_log", entry).catch(() => undefined);
  };

  const report = (
    source: string,
    reason: unknown,
    level: Entry["level"],
    componentStack?: string,
  ) => {
    const { message, stack } = describe(reason);
    const where = [stack, componentStack && `component stack:${componentStack}`]
      .filter((part) => part !== undefined && part !== "")
      .join("\n");
    const key = `${message}\n${where}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count === 1) {
      send({ level, message, stack: where === "" ? null : where, source });
    } else if ((count & (count - 1)) === 0) {
      send({
        level: "info",
        message: `repeated ${String(count)} times: ${message}`,
        stack: null,
        source,
      });
    }
  };

  window.addEventListener("error", (event) => {
    report("error", event.error ?? event.message, "error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    report("unhandledrejection", event.reason, "error");
  });
  return {
    root: {
      onCaughtError: (error, { componentStack }) => {
        report("onCaughtError", error, "error", componentStack);
      },
      onUncaughtError: (error, { componentStack }) => {
        report("onUncaughtError", error, "error", componentStack);
      },
      onRecoverableError: (error, { componentStack }) => {
        report("onRecoverableError", error, "warn", componentStack);
      },
    },
    caught: (source, reason) => {
      report(source, reason, "error");
    },
  };
}

/**
 * A thrown value as the log takes it. An `IpcError` is logged by its code,
 * since its message can quote what the API server said of a request (P6), and
 * V8 puts that message at the head of its stack.
 */
function describe(reason: unknown): { message: string; stack: string } {
  if (reason instanceof IpcError) {
    return {
      message: reason.code,
      stack: (reason.stack ?? "").replace(reason.message, reason.code),
    };
  }
  if (reason instanceof Error) {
    return { message: reason.message, stack: reason.stack ?? "" };
  }
  return { message: String(reason), stack: "" };
}

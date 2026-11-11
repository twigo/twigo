import type { ExecInput } from "../uri";

/** What an attach's tab says once it runs, in the scrollback before the process's output. */
export function attached(container: string, stdin: boolean): string {
  return stdin
    ? `Attached to the main process of ${container}: what you type reaches it, Ctrl-C included. If nothing shows, press Enter.`
    : `Attached to the output of ${container}: what it writes from now on shows here, and what it wrote before is in its logs. It keeps no stdin, so nothing typed reaches it.`;
}

/** A tab's title: the pod and the container, a second shell or an attach told apart. */
export function execTitle({ pod, container, n, attach }: ExecInput): string {
  const more = [
    ...(attach === true ? ["attach"] : []),
    ...(n === undefined ? [] : [String(n)]),
  ];
  return `${pod} · ${container}${more.length === 0 ? "" : ` (${more.join(", ")})`}`;
}

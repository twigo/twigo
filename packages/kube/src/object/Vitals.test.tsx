import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Gvr, Measure, ShownUsage, Vital } from "@twigo/protocol";
import type { Verdict } from "./verdict";
import { Vitals } from "./Vitals";
import { labelsOf, measured, vitalCells, type VitalCell } from "./vitalCells";

const POD: Gvr = { group: "", version: "v1", resource: "pods" };
const DEPLOYMENT: Gvr = {
  group: "apps",
  version: "v1",
  resource: "deployments",
};
const MI = 1024 * 1024;
const NOW = Date.parse("2026-11-18T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const measure = (rest: Partial<Measure>): Measure => ({
  used: null,
  request: null,
  limit: null,
  allocatable: null,
  ...rest,
});

const usage = (rest: Partial<ShownUsage>): ShownUsage => ({
  state: "ready",
  waiting: false,
  sampled: null,
  cpu: measure({}),
  memory: measure({}),
  containers: [],
  ...rest,
});

const text = (
  label: string,
  value: string,
  note: Vital["note"] = [],
): Vital => ({
  label,
  value: { type: "text", text: value },
  note,
});

const ago = (ms: number): Vital["note"] => [
  { type: "ago", at: new Date(NOW - ms).toISOString() },
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const verdict = (word: string, rest: Partial<Verdict> = {}): Verdict => ({
  word,
  tone: undefined,
  finished: false,
  ...rest,
});

function strip(
  vitals: readonly Vital[],
  shown: ShownUsage | undefined,
  alarm?: Verdict,
) {
  render(
    <Vitals
      cells={vitalCells(POD, vitals, shown, undefined)}
      verdict={alarm}
      layout="strip"
    />,
  );
}

const toned = (label: string, value: string): Vital => ({
  label,
  value: { type: "toned", text: value, tone: "warning" },
  note: [],
});

function sized(room: number, share: number, base: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      if (!this.closest("[aria-hidden]")) return room;
      return this.textContent.includes("% of")
        ? share
        : this.textContent.includes("of ")
          ? base
          : 0;
    },
  );
}

const cell = (label: string) => {
  const caption = screen.getByText(label, { selector: "dt" });
  return caption.nextElementSibling as HTMLElement;
};

describe("a pod's strip", () => {
  test("holds Rust's Ready and Restarts, then its CPU and Memory from the usage", () => {
    sized(140, 100, 60);
    strip(
      [text("Ready", "1/1"), text("Restarts", "0")],
      usage({
        cpu: measure({ used: 25_000_000, limit: 100_000_000 }),
        memory: measure({ used: 64 * MI, request: 128 * MI }),
      }),
    );
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(
      ["Ready", "Restarts", "CPU", "Memory"],
    );
    expect(cell("CPU").textContent).toBe("25m25% of limit");
    expect(cell("Memory").textContent).toBe("64Mi50% of request");
  });

  test("a share of 10,000 % or more reads >9999%, and the tooltip says the exact share", () => {
    sized(160, 100, 60);
    strip([], usage({ memory: measure({ used: 1023 * MI, request: MI }) }));
    expect(cell("Memory").textContent).toBe("1023Mi>9999% of request");
    expect(cell("Memory").title).toBe("1023Mi of 1Mi request, 102300%");
  });

  test("a measure held against nothing is its figure alone, and has no meter", () => {
    strip([], usage({ cpu: measure({ used: 25_000_000 }) }));
    expect(cell("CPU").textContent).toBe("25m");
    expect(screen.queryByRole("meter")).toBeNull();
  });

  test.each([
    [140, "25m50% of limit", ""],
    [115, "25mof 50m", "25m of 50m limit, 50%"],
    [75, "25m", "25m of 50m limit, 50%"],
  ])(
    "a measure says as much beside its figure as a cell of %i px holds with 16 px to spare, and its tooltip says what it leaves out",
    (room, said, tooltip) => {
      sized(room, 100, 60);
      strip(
        [],
        usage({ cpu: measure({ used: 25_000_000, limit: 50_000_000 }) }),
      );
      expect(cell("CPU").textContent).toBe(said);
      expect(cell("CPU").title).toBe(tooltip);
    },
  );

  test("a fuller form comes back only with 16 px to spare, and stays while it fits", () => {
    const view = (shown: ShownUsage) => (
      <Vitals
        cells={vitalCells(POD, [], shown, undefined)}
        verdict={undefined}
        layout="strip"
      />
    );
    const shown = usage({
      cpu: measure({ used: 25_000_000, limit: 50_000_000 }),
    });
    sized(75, 100, 60);
    const { rerender } = render(view(shown));
    expect(cell("CPU").textContent).toBe("25m");
    for (const [room, expected] of [
      [75, "25m"],
      [76, "25mof 50m"],
      [60, "25mof 50m"],
      [59, "25m"],
    ] as const) {
      sized(room, 100, 60);
      rerender(view({ ...shown }));
      expect(cell("CPU").textContent, String(room)).toBe(expected);
    }
  });

  test("a cell whose figures come after the strip is drawn is not held to a form that was never measured: the room between a form's width and its width with the margin leaves it out", () => {
    const view = (shown: ShownUsage | undefined) => (
      <Vitals
        cells={vitalCells(POD, [], shown, undefined)}
        verdict={undefined}
        layout="strip"
      />
    );
    sized(104, 120, 98);
    const { rerender } = render(view(undefined));
    rerender(
      view(usage({ cpu: measure({ used: 25_000_000, limit: 50_000_000 }) })),
    );
    expect(cell("CPU").textContent).toBe("25m");
  });

  test("a measure toned from 90 % of its limit, with a meter in that tone", () => {
    strip([], usage({ memory: measure({ used: 95 * MI, limit: 100 * MI }) }));
    expect(
      cell("Memory").querySelector(".text-warn-foreground"),
    ).not.toBeNull();
    expect(screen.getByRole("meter", { name: "Memory" })).toBeTruthy();
  });

  test.each([
    ["no usage yet or an absent Metrics API", undefined, /^No figures yet/],
    [
      "a usage that waits for its first sample",
      usage({ waiting: true }),
      /^Waiting/,
    ],
    [
      "a Metrics API that does not answer",
      usage({ state: "unavailable" }),
      /does not answer/,
    ],
    [
      "a Metrics API that refuses the person",
      usage({ state: "forbidden" }),
      /may not read metrics/,
    ],
    ["an answer without the pod", usage({}), /^No data yet/],
  ])("%s is a dash with its reason", (_, shown, reason) => {
    strip([text("Ready", "1/1")], shown);
    for (const label of ["CPU", "Memory"]) {
      const value = cell(label);
      expect(value.textContent.startsWith("–")).toBe(true);
      expect(value.querySelector("[title]")?.getAttribute("title")).toMatch(
        reason,
      );
    }
  });
});

describe("the Restarts vital", () => {
  test("a restart within the hour is news, in the warning tone with its age", () => {
    strip([text("Restarts", "2", ago(28 * MINUTE))], undefined);
    expect(
      cell("Restarts").querySelectorAll(".text-warn-foreground"),
    ).toHaveLength(2);
    expect(cell("Restarts").textContent).toBe("228m ago");
  });

  test("one that lies past the hour is plain, and a zero is quiet", () => {
    strip([text("Restarts", "2", ago(3 * HOUR))], undefined);
    expect(cell("Restarts").querySelector(".text-warn-foreground")).toBeNull();
    cleanup();
    strip([text("Restarts", "0")], undefined);
    expect(cell("Restarts").querySelector(".text-quiet")?.textContent).toBe(
      "0",
    );
  });

  test("a verdict that raises the alarm already leaves a recent restart plain, as a list row does", () => {
    strip(
      [text("Restarts", "2", ago(5 * MINUTE))],
      undefined,
      verdict("CrashLoopBackOff", { tone: "error" }),
    );
    expect(cell("Restarts").querySelector(".text-warn-foreground")).toBeNull();
  });

  test("an object that finished has no news in a restart, as in the list", () => {
    strip(
      [text("Ready", "0/1"), text("Restarts", "1", ago(5 * MINUTE))],
      undefined,
      verdict("Completed", { finished: true }),
    );
    expect(cell("Restarts").querySelector(".text-warn-foreground")).toBeNull();
    cleanup();
    strip(
      [text("Restarts", "1", ago(5 * MINUTE))],
      undefined,
      verdict("Running"),
    );
    expect(
      cell("Restarts").querySelector(".text-warn-foreground"),
    ).not.toBeNull();
  });

  test("a vital that is toned already, a Ready short of its containers, leaves a recent restart plain, as the list's ratio does", () => {
    strip(
      [toned("Ready", "1/2"), text("Restarts", "1", ago(5 * MINUTE))],
      undefined,
      verdict("Running"),
    );
    expect(cell("Ready").querySelector(".text-warn-foreground")).not.toBeNull();
    expect(cell("Restarts").querySelector(".text-warn-foreground")).toBeNull();
  });

  test("what Rust toned, a container finding's subject, keeps its tone whatever the verdict", () => {
    strip(
      [
        {
          label: "Restarts",
          value: { type: "toned", text: "4", tone: "danger" },
          note: ago(2 * HOUR),
        },
      ],
      undefined,
      verdict("CrashLoopBackOff", { tone: "error" }),
    );
    expect(cell("Restarts").querySelector(".text-error")?.textContent).toBe(
      "4",
    );
  });

  test("the age turns plain as the hour passes, with no other draw", () => {
    strip([text("Restarts", "2", ago(59 * MINUTE))], undefined);
    expect(
      cell("Restarts").querySelector(".text-warn-foreground"),
    ).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(2 * MINUTE);
    });
    expect(cell("Restarts").querySelector(".text-warn-foreground")).toBeNull();
  });
});

describe("the cells of an object", () => {
  test("a Deployment has Rust's vitals as they come, and a kind with none has no strip", () => {
    const cells = vitalCells(
      DEPLOYMENT,
      [text("Ready", "2/2"), text("Updated", "2/2"), text("Revision", "2")],
      undefined,
      undefined,
    );
    expect(labelsOf(cells)).toEqual(["Ready", "Updated", "Revision"]);
    expect(vitalCells(DEPLOYMENT, [], undefined, undefined)).toEqual([]);
    const { container } = render(
      <Vitals cells={[]} verdict={undefined} layout="strip" />,
    );
    expect(container.firstChild).toBeNull();
  });

  test("a strip holds at most four cells", () => {
    const cells = vitalCells(
      POD,
      [text("A", "1"), text("B", "1"), text("C", "1")],
      undefined,
      undefined,
    );
    expect(labelsOf(cells)).toEqual(["A", "B", "C", "CPU"]);
  });

  test("before the object comes, the labels the last of its kind had stand in as dashes", () => {
    const cells: readonly VitalCell[] = vitalCells(POD, undefined, undefined, [
      "Ready",
      "Restarts",
      "CPU",
      "Memory",
    ]);
    render(<Vitals cells={cells} verdict={undefined} layout="strip" />);
    expect(screen.getAllByRole("term")).toHaveLength(4);
    for (const label of ["Ready", "Restarts", "CPU", "Memory"]) {
      expect(cell(label).textContent).toBe("–");
    }
    expect(vitalCells(POD, undefined, undefined, undefined)).toEqual([]);
  });

  test("a measure says its figure or why it has none", () => {
    expect(measured(undefined, "cpu").state).toBe("none");
    expect(
      measured(usage({ cpu: measure({ used: 5_000_000 }) }), "cpu"),
    ).toMatchObject({ state: "figure" });
  });
});

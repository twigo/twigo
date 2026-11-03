import type { ListBatch, Sort } from "@twigo/protocol";
import type { Workbench } from "@twigo/workbench";
import type { ListProbe, Probe } from "./probe";

const SCROLL_SECONDS = 5;
const SCROLL_PX_PER_SECOND = 4000;
/**
 * Clicked in this order, from the default order by Name, so that every click
 * changes the first rows of the pods of `bench/pods.sh` on kwok, besides the
 * cluster's own; each column's second click descends. They all run, so a
 * Status sort would leave them in the order of their ids either way. The
 * last, Restarts descending, leaves pods the churn changes on screen.
 */
export const SORTS: readonly Sort[] = [
  "Age",
  "Namespace",
  "Name",
  "Restarts",
].flatMap((column) => [
  { column, descending: false },
  { column, descending: true },
]);
const TOP_ROWS = 10;
const RESTARTS = "Restarts";
/** The DOM carries no row ids, so rows are told apart by these cells. */
const KEYS = ["Namespace", "Name"];
const CHANGE_SECONDS = 60;
const WAIT_MS = 5000;
/** The list waits for the space's discovery, then lists every pod. */
const FIRST_PAINT_WAIT_MS = 30_000;
const PAINT_TIMEOUT_MS = 1000;

/** A restart count the churn set, painted at `at`, in Unix milliseconds. */
export interface Paint {
  pod: string;
  restarts: number;
  at: number;
}

/** What `twigo-bench report` reads as webview.json. */
export interface Results {
  rows: number;
  refreshMs: number;
  firstPaintMs: number;
  scroll: {
    seconds: number;
    pxPerSecond: number;
    frameMs: number[];
    blankFrames: number;
  };
  sort: { column: string; descending: boolean; ms: number }[];
  changes: {
    seconds: number;
    painted: Paint[];
    offscreen: number;
    superseded: number;
    timedOut: number;
  };
}

function frame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Called within a frame's callbacks: resolves once that frame is rendered. */
function rendered(): Promise<number> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      resolve(performance.now());
    };
    channel.port2.postMessage(null);
  });
}

/** Checks `ready` on every frame, and resolves when the first frame where it holds is rendered. */
async function paintedWhen(
  ready: () => boolean,
  what: string,
  waitMs = WAIT_MS,
) {
  const deadline = performance.now() + waitMs;
  for (;;) {
    await frame();
    if (ready()) return rendered();
    if (performance.now() > deadline) throw new Error(`no ${what}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function grid(): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="grid"]'),
  ].find((g) => g.getAttribute("aria-label")?.toLowerCase() === "pods");
  if (!found) throw new Error("the pod list is not on screen");
  return found;
}

function headers(table: HTMLElement): HTMLButtonElement[] {
  return [
    ...table.querySelectorAll<HTMLButtonElement>(
      '[aria-rowindex="1"] button[role="columnheader"]',
    ),
  ];
}

function header(table: HTMLElement, column: string): HTMLButtonElement {
  const found = headers(table).find((h) => h.textContent === column);
  if (!found) throw new Error(`no ${column} header`);
  return found;
}

function rowAt(table: HTMLElement, index: number): HTMLElement | null {
  return table.querySelector(`[role="row"][aria-rowindex="${index + 2}"]`);
}

function cellText(row: HTMLElement, position: number): string | undefined {
  return (
    row.querySelectorAll(':scope > [role="gridcell"][data-column]')[position]
      ?.textContent ?? undefined
  );
}

function onScreen(table: HTMLElement, row: HTMLElement): boolean {
  const top =
    table.querySelector('[aria-rowindex="1"]')?.getBoundingClientRect()
      .bottom ?? table.getBoundingClientRect().top;
  const { top: rowTop, bottom } = row.getBoundingClientRect();
  return bottom > top && rowTop < table.getBoundingClientRect().bottom;
}

/** Whether a row on screen still shows skeletons, its data not yet in. */
function blank(table: HTMLElement): boolean {
  return [
    ...table.querySelectorAll<HTMLElement>(
      '[role="row"]:not([aria-rowindex="1"])',
    ),
  ].some((row) => onScreen(table, row) && cellText(row, 0) === undefined);
}

/** The first rows of the list's window, once it starts at the top and holds them. */
export function topRows(list: ListProbe): string[] | undefined {
  const count = Math.min(TOP_ROWS, list.total);
  if (list.start !== 0 || list.ids.length < count) return undefined;
  const at = KEYS.map((key) => list.columns.findIndex((c) => c.name === key));
  return list.ids.slice(0, count).map((id) => {
    const cells = list.cells(id);
    return at.map((i) => String(cells?.[i] ?? "")).join("/");
  });
}

/** The first rows on screen, named as `topRows` names them. */
function shownRows(table: HTMLElement, count: number): string[] {
  const titles = headers(table).map((h) => h.textContent);
  const at = KEYS.map((key) => titles.indexOf(key));
  const shown: string[] = [];
  for (let index = 0; index < count; index++) {
    const row = rowAt(table, index);
    if (!row) break;
    shown.push(at.map((i) => cellText(row, i) ?? "").join("/"));
  }
  return shown;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

export function shows(table: HTMLElement, expected: readonly string[]) {
  return same(shownRows(table, expected.length), expected);
}

/** Rejects when `promise` has not settled within `ms`, naming what it waited for. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no ${what} within ${String(ms)} ms`));
    }, ms);
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer);
    });
  });
}

function nextBatch(
  list: ListProbe,
  matches: (batch: ListBatch) => boolean,
  what: string,
): Promise<number> {
  let stop: () => void = () => undefined;
  const matched = new Promise<number>((resolve) => {
    stop = list.listen((at, batch) => {
      if (matches(batch)) {
        stop();
        resolve(at);
      }
    });
  });
  return within(matched, WAIT_MS, what).finally(stop);
}

/** Opens the space's pod list: from the click to its first rows painted. */
async function open(workbench: Workbench, probe: Probe, space: string) {
  const opened = probe.next();
  const clicked = performance.now();
  workbench.editors.open(`k8s-list://${space}/v1/pods`);
  const list = await within(
    opened,
    FIRST_PAINT_WAIT_MS,
    "list subscription for the pods",
  );
  const paintedAt = await paintedWhen(
    () => {
      const row = rowAt(grid(), 0);
      return row !== null && cellText(row, 0) !== undefined;
    },
    "first rows",
    FIRST_PAINT_WAIT_MS,
  );
  return { list, firstPaintMs: paintedAt - clicked };
}

async function refresh(): Promise<number> {
  const stamps: number[] = [];
  for (let i = 0; i < 61; i++) stamps.push(await frame());
  const intervals = stamps.slice(1).map((t, i) => t - (stamps[i] ?? t));
  intervals.sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)] ?? 0;
}

async function scroll(): Promise<Results["scroll"]> {
  const table = grid();
  const frameMs: number[] = [];
  let blankFrames = 0;
  const first = await frame();
  let last = first;
  for (;;) {
    const at = await frame();
    frameMs.push(at - last);
    last = at;
    if (blank(table)) blankFrames++;
    const elapsed = (at - first) / 1000;
    if (elapsed >= SCROLL_SECONDS) break;
    table.scrollTop = elapsed * SCROLL_PX_PER_SECOND;
  }
  return {
    seconds: SCROLL_SECONDS,
    pxPerSecond: SCROLL_PX_PER_SECOND,
    frameMs,
    blankFrames,
  };
}

async function top(): Promise<void> {
  const table = grid();
  table.scrollTop = 0;
  await paintedWhen(() => {
    const row = rowAt(table, 0);
    return (
      row !== null && onScreen(table, row) && cellText(row, 0) !== undefined
    );
  }, "rows at the top");
}

async function sorts(probe: Probe): Promise<Results["sort"]> {
  await top();
  const samples: Results["sort"] = [];
  for (const { column, descending } of SORTS) {
    await sleep(300);
    const sorted = `${column} ${descending ? "descending" : "ascending"}`;
    const table = grid();
    const button = header(table, column);
    const before = shownRows(table, TOP_ROWS);
    const opened = probe.next();
    const clicked = performance.now();
    button.click();
    const list = await within(opened, WAIT_MS, `list sorted by ${sorted}`);
    let expected: string[] = [];
    await nextBatch(
      list,
      () => {
        const first = topRows(list);
        if (first) expected = first;
        return first !== undefined;
      },
      `first rows sorted by ${sorted}`,
    );
    if (same(expected, before)) {
      throw new Error(
        `sorting by ${sorted} leaves the first rows as they were`,
      );
    }
    const painted = await paintedWhen(
      () => shows(table, expected),
      `rows sorted by ${sorted}`,
    );
    const shown = button.getAttribute("aria-sort");
    if (shown !== (descending ? "descending" : "ascending")) {
      throw new Error(`clicking ${column} sorted it ${String(shown)}`);
    }
    samples.push({ column, descending, ms: painted - clicked });
  }
  return samples;
}

/** The pod a row id names, its last part. */
function podOf(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

/**
 * Watches the Restarts cells of the rows on screen change for a minute, and
 * records when each new count was painted, for the report to join with the
 * churn's log of when it sent that count.
 */
async function changes(
  list: ListProbe,
  steady: () => Promise<void>,
): Promise<Results["changes"]> {
  const table = grid();
  const position = headers(table).findIndex((h) => h.textContent === RESTARTS);
  if (position < 0) throw new Error(`no ${RESTARTS} header`);
  const pending = new Map<string, string>();
  const result: Results["changes"] = {
    seconds: CHANGE_SECONDS,
    painted: [],
    offscreen: 0,
    superseded: 0,
    timedOut: 0,
  };
  const arrived = new Map<string, number>();
  const stop = list.listen((at, _, changed) => {
    for (const { id, column, text } of changed) {
      if (column !== RESTARTS) continue;
      if (pending.has(id)) result.superseded++;
      pending.set(id, text);
      arrived.set(id, at);
    }
  });
  await steady();
  const end = performance.now() + CHANGE_SECONDS * 1000;
  while (performance.now() < end) {
    const now = await frame();
    const shown: { id: string; text: string }[] = [];
    for (const [id, text] of pending) {
      const index = list.indexOf(id);
      const row = index < 0 ? null : rowAt(table, index);
      if (!row || !onScreen(table, row)) {
        result.offscreen++;
        pending.delete(id);
      } else if (cellText(row, position) === text) {
        shown.push({ id, text });
        pending.delete(id);
      } else if (now - (arrived.get(id) ?? now) > PAINT_TIMEOUT_MS) {
        result.timedOut++;
        pending.delete(id);
      }
    }
    if (shown.length > 0) {
      const at = performance.timeOrigin + (await rendered());
      for (const { id, text } of shown) {
        result.painted.push({
          pod: podOf(id),
          restarts: Number.parseInt(text, 10),
          at,
        });
      }
    }
  }
  stop();
  return result;
}

/**
 * Opens the space's pod list, then scrolls it, sorts it and watches it
 * change, timing each in the webview (ARCHITECTURE 3.8). `steady` runs once
 * the list is open under churn, for the harness to sample memory.
 */
export async function drive(
  workbench: Workbench,
  probe: Probe,
  { space, steady }: { space: string; steady: () => Promise<void> },
): Promise<Results> {
  const first = await open(workbench, probe, space);
  await sleep(1000);
  const refreshMs = await refresh();
  const scrolled = await scroll();
  const sorted = await sorts(probe);
  const list = probe.lists[probe.lists.length - 1] ?? first.list;
  await top();
  const changed = await changes(list, steady);
  return {
    rows: list.total,
    refreshMs,
    firstPaintMs: first.firstPaintMs,
    scroll: scrolled,
    sort: sorted,
    changes: changed,
  };
}
